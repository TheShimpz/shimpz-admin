//! The Supervisor's factors in the store: setup, TOTP ceremonies, recovery codes, passkeys, the refused-attempt
//! counters, and session revocation, each one transaction journaled before it is persisted.

use super::{
    Journal, StateError, Store,
    classify::{
        AuthState, MAX_SECOND_FACTOR_FAILURES, authentication_state, validated_passkey,
        validated_passkeys,
    },
};
use crate::{
    json::{self, Value},
    signin::{
        passkeys::{Authentication, MAX_PASSKEYS, PasskeyError, rp_id_for_origin},
        password, recovery, token,
        totp::{self, Enrollment, Verification},
    },
    supervisor::identity::LocalIdentity,
};

/// What a TOTP ceremony requires of the state, and whether an accepted code completes an enrollment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ceremony {
    /// The first enrollment's confirmation.
    Setup,
    /// The re-enrollment a recovery code began.
    Recovery,
    /// A sign-in's second factor.
    Login,
    /// An operation's second factor.
    Operation,
}

impl Ceremony {
    const fn requires(self) -> AuthState {
        match self {
            Self::Setup => AuthState::EnrollmentRequired,
            Self::Recovery => AuthState::RecoveryEnrollment,
            Self::Login | Self::Operation => AuthState::Configured,
        }
    }

    const fn enrolls(self) -> bool {
        matches!(self, Self::Setup | Self::Recovery)
    }
}

/// How a passkey assertion was committed: the session secret after it, and the reason it suspended the passkey.
pub type PasskeyCommit = (String, Option<&'static str>);

fn counters(data: &mut Value) -> Option<&mut Vec<(String, Value)>> {
    match data {
        Value::Object(members) => members
            .iter_mut()
            .find(|(name, _)| name == "second_factor_failures")
            .and_then(|(_, value)| match value {
                Value::Object(counters) => Some(counters),
                _ => None,
            }),
        _ => None,
    }
}

fn counter(data: &Value, name: &str) -> i64 {
    data.get("second_factor_failures")
        .and_then(|counters| counters.get(name))
        .and_then(json::as_int)
        .unwrap_or(0)
}

fn set_counter(data: &mut Value, name: &str, value: i64) {
    if let Some(counters) = counters(data)
        && let Some(slot) = counters.iter_mut().find(|(key, _)| key == name)
    {
        slot.1 = json::int(value);
    }
}

fn second_factor_refused(data: &mut Value) {
    let since = (counter(data, "since_sign_in") + 1).min(MAX_SECOND_FACTOR_FAILURES);
    set_counter(data, "since_sign_in", since);
}

fn signed_in(data: &mut Value) {
    let reported = (counter(data, "unacknowledged") + counter(data, "since_sign_in"))
        .min(MAX_SECOND_FACTOR_FAILURES);
    set_counter(data, "unacknowledged", reported);
    set_counter(data, "since_sign_in", 0);
}

fn member_mut<'a>(data: &'a mut Value, name: &str) -> Option<&'a mut Value> {
    match data {
        Value::Object(members) => members
            .iter_mut()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value),
        _ => None,
    }
}

fn generation(data: &Value) -> i64 {
    data.get("factor_generation")
        .and_then(json::as_int)
        .unwrap_or(0)
}

fn new_secret() -> String {
    crate::random::hex(32)
}

fn active_matching(records: &[Value], origin: &str, rp_id: &str) -> Vec<Value> {
    records
        .iter()
        .filter(|record| {
            json::get_str(record, "status") == Some("active")
                && json::get_str(record, "origin") == Some(origin)
                && json::get_str(record, "rp_id") == Some(rp_id)
        })
        .cloned()
        .collect()
}

impl Store {
    /// Creates the password and the resumable mandatory TOTP enrollment atomically, with a fresh Supervisor identity.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::AlreadyConfigured`] once a password exists, [`StateError::Authority`] for a partial
    /// identity, or a store error.
    pub fn begin_supervisor_setup(&self, verifier: &str) -> Result<Enrollment, StateError> {
        let now = self.now();
        self.mutate_always(|data| {
            if password::password_set(data).map_err(|_| StateError::PasswordRecord)? {
                return Err(StateError::AlreadyConfigured);
            }
            if [
                "session_secret",
                "supervisor_id",
                "supervisor_signing_key",
                "created",
            ]
            .iter()
            .any(|key| json::contains(data, key))
            {
                return Err(StateError::Authority);
            }
            let identity = LocalIdentity::generate();
            let factor = totp::new_record(now);
            let enrollment = totp::enrollment(&factor).map_err(|_| StateError::Totp)?;
            for (key, value) in [
                ("password_verifier", json::text(verifier)),
                ("session_secret", json::text(new_secret())),
                ("supervisor_id", json::text(&identity.supervisor_id)),
                ("supervisor_signing_key", json::text(identity.key_hex())),
                ("auth_version", json::int(1)),
                ("factor_generation", json::int(1)),
                ("webauthn_user_id", json::text(new_secret())),
                ("passkeys", Value::Array(Vec::new())),
                ("totp", factor),
                (
                    "second_factor_failures",
                    json::object(vec![
                        ("since_sign_in", json::int(0)),
                        ("unacknowledged", json::int(0)),
                    ]),
                ),
                ("recovery_codes", Value::Null),
                ("created", json::int(now)),
            ] {
                json::set(data, key, value);
            }
            Ok(enrollment)
        })
    }

    /// Resumes the same pending secret after a bounded password check.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Totp`] when no first enrollment is pending.
    pub fn resume_totp_enrollment(&self) -> Result<Enrollment, StateError> {
        let now = self.now();
        self.mutate_always(|data| {
            if authentication_state(data)? != AuthState::EnrollmentRequired {
                return Err(StateError::Totp);
            }
            let factor = member_mut(data, "totp").ok_or(StateError::Totp)?;
            totp::resume(factor, now).map_err(|_| StateError::Totp)
        })
    }

    /// Persists one TOTP attempt, journaling its outcome first: the generation its ticket was issued under is checked
    /// in the same transaction, a refused code counts, and an accepted enrollment activates the factor with `codes`.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Totp`] when the ceremony is unavailable, or a journal or store error.
    pub fn verify_totp(
        &self,
        code: &Value,
        ceremony: Ceremony,
        expected_generation: Option<i64>,
        codes: Option<&Value>,
        journal: Journal<'_, Verification>,
    ) -> Result<Verification, StateError> {
        if ceremony.enrolls() {
            recovery::validated(codes.unwrap_or(&Value::Null)).map_err(|_| StateError::Totp)?;
        }
        let now = self.now();
        self.mutate(
            |data| {
                if authentication_state(data)? != ceremony.requires() {
                    return Err(StateError::Totp);
                }
                if expected_generation.is_some_and(|expected| generation(data) != expected) {
                    return Ok(Verification::Changed);
                }
                let factor = member_mut(data, "totp").ok_or(StateError::Totp)?;
                let result = totp::verify(factor, code, now).map_err(|_| StateError::Totp)?;
                match result {
                    Verification::Invalid | Verification::Locked => second_factor_refused(data),
                    Verification::Accepted if ceremony != Ceremony::Operation => signed_in(data),
                    _ => {}
                }
                if result == Verification::Accepted && ceremony.enrolls() {
                    json::set(
                        data,
                        "recovery_codes",
                        codes.cloned().unwrap_or(Value::Null),
                    );
                    let next = generation(data) + 1;
                    json::set(data, "factor_generation", json::int(next));
                    json::set(data, "session_secret", json::text(new_secret()));
                }
                Ok(result)
            },
            |_| true,
            Some(journal),
        )
    }

    /// Derives a typed recovery code under the current set's salt, before the transaction that spends it (an scrypt
    /// derivation: run it off the event loop).
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Totp`] when recovery codes are unavailable.
    pub fn recovery_candidate(&self, typed: &Value) -> Result<recovery::Candidate, StateError> {
        let data = self.get()?;
        if !matches!(
            authentication_state(&data)?,
            AuthState::Configured | AuthState::RecoveryEnrollment
        ) {
            return Err(StateError::Totp);
        }
        recovery::candidate(data.get("recovery_codes").unwrap_or(&Value::Null), typed)
            .map_err(|_| StateError::Totp)
    }

    /// Spends one recovery code under the TOTP failure budget, journaling the outcome first. An accepted code replaces
    /// TOTP with a fresh pending factor and rotates the session secret; a ceremony from before a factor change spends
    /// nothing.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Totp`] when recovery codes are unavailable, or a journal or store error.
    pub fn spend_recovery_code(
        &self,
        derived: &recovery::Candidate,
        expected_generation: i64,
        journal: Journal<'_, (Verification, Option<Enrollment>)>,
    ) -> Result<(Verification, Option<Enrollment>), StateError> {
        let now = self.now();
        self.mutate(
            |data| {
                if !matches!(
                    authentication_state(data)?,
                    AuthState::Configured | AuthState::RecoveryEnrollment
                ) {
                    return Err(StateError::Totp);
                }
                let salt = data
                    .get("recovery_codes")
                    .and_then(|codes| json::get_str(codes, "salt"));
                if generation(data) != expected_generation || salt != Some(derived.salt.as_str()) {
                    return Ok((Verification::Changed, None));
                }
                if totp::locked(data.get("totp").unwrap_or(&Value::Null), now) {
                    second_factor_refused(data);
                    return Ok((Verification::Locked, None));
                }
                let codes = member_mut(data, "recovery_codes").ok_or(StateError::Totp)?;
                if !recovery::spend(codes, derived, now).map_err(|_| StateError::Totp)? {
                    second_factor_refused(data);
                    let factor = member_mut(data, "totp").ok_or(StateError::Totp)?;
                    return Ok((totp::record_failure(factor, now), None));
                }
                let factor = totp::new_record(now);
                let enrollment = totp::enrollment(&factor).map_err(|_| StateError::Totp)?;
                json::set(data, "totp", factor);
                json::set(
                    data,
                    "factor_generation",
                    json::int(expected_generation + 1),
                );
                json::set(data, "session_secret", json::text(new_secret()));
                Ok((Verification::Accepted, Some(enrollment)))
            },
            |result| result.0 != Verification::Changed,
            Some(journal),
        )
    }

    /// Replaces the whole recovery set, journaling it first; every code of the previous set stops working.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Totp`] unless configured, or a journal or store error.
    pub fn replace_recovery_codes(
        &self,
        codes: &Value,
        journal: Journal<'_, ()>,
    ) -> Result<(), StateError> {
        recovery::validated(codes).map_err(|_| StateError::Totp)?;
        self.mutate(
            |data| {
                if authentication_state(data)? != AuthState::Configured {
                    return Err(StateError::Totp);
                }
                json::set(data, "recovery_codes", codes.clone());
                let next = generation(data) + 1;
                json::set(data, "factor_generation", json::int(next));
                Ok(())
            },
            |()| true,
            Some(journal),
        )
    }

    /// How many current recovery codes are unused.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Totp`] unless configured.
    pub fn recovery_codes_remaining(&self) -> Result<usize, StateError> {
        let data = self.get()?;
        if authentication_state(&data)? != AuthState::Configured {
            return Err(StateError::Totp);
        }
        recovery::remaining(data.get("recovery_codes").unwrap_or(&Value::Null))
            .map_err(|_| StateError::Totp)
    }

    /// The refused second-factor attempts sign-ins reported and the Supervisor has not acknowledged.
    ///
    /// # Errors
    ///
    /// Returns an invalid record or store error.
    pub fn unacknowledged_second_factor_failures(&self) -> Result<i64, StateError> {
        let data = self.get()?;
        authentication_state(&data)?;
        Ok(counter(&data, "unacknowledged"))
    }

    /// Acknowledges `count` reported failures, never more than are reported.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::PasswordRecord`] unless configured, or a store error.
    pub fn acknowledge_second_factor_failures(&self, count: i64) -> Result<(), StateError> {
        self.mutate_always(|data| {
            if authentication_state(data)? != AuthState::Configured {
                return Err(StateError::PasswordRecord);
            }
            let left = (counter(data, "unacknowledged") - count).max(0);
            set_counter(data, "unacknowledged", left);
            Ok(())
        })
    }

    /// Rotates every session when the presented session is currently valid.
    ///
    /// # Errors
    ///
    /// Returns a store error.
    pub fn revoke_sessions_for_logout(
        &self,
        sessions: &crate::signin::sessions::Sessions,
        session_token: &str,
    ) -> Result<bool, StateError> {
        let clock = &self.clock;
        self.mutate(
            |data| {
                if authentication_state(data)? != AuthState::Configured {
                    return Ok(false);
                }
                let secret = json::get_str(data, "session_secret")
                    .unwrap_or_default()
                    .to_owned();
                if token::verify(sessions, clock, &secret, session_token, false).is_none() {
                    return Ok(false);
                }
                json::set(data, "session_secret", json::text(new_secret()));
                Ok(true)
            },
            |rotated| *rotated,
            None,
        )
    }

    /// Private copies of the active passkeys of one exact origin.
    ///
    /// # Errors
    ///
    /// Returns a passkey or store error.
    pub fn active_passkeys(&self, origin: &str) -> Result<Vec<Value>, StateError> {
        let rp_id = rp_id_for_origin(origin).map_err(StateError::Passkey)?;
        let data = self.get()?;
        authentication_state(&data)?;
        let records = validated_passkeys(data.get("passkeys").unwrap_or(&Value::Null))
            .map_err(StateError::Passkey)?;
        Ok(active_matching(records, origin, &rp_id))
    }

    /// The same-origin exclusions of a registration, only while global active capacity remains.
    ///
    /// # Errors
    ///
    /// Returns [`PasskeyError::Unavailable`] at capacity, or a store error.
    pub fn passkeys_for_registration(&self, origin: &str) -> Result<Vec<Value>, StateError> {
        let rp_id = rp_id_for_origin(origin).map_err(StateError::Passkey)?;
        let data = self.get()?;
        authentication_state(&data)?;
        let records = validated_passkeys(data.get("passkeys").unwrap_or(&Value::Null))
            .map_err(StateError::Passkey)?;
        let active = records
            .iter()
            .filter(|record| json::get_str(record, "status") == Some("active"))
            .count();
        if active >= MAX_PASSKEYS {
            return Err(StateError::Passkey(PasskeyError::Unavailable(
                "maximum passkey count reached",
            )));
        }
        Ok(active_matching(records, origin, &rp_id))
    }

    /// The one active exact-origin credential an assertion names.
    ///
    /// # Errors
    ///
    /// Returns [`PasskeyError::Unavailable`] when no single one matches.
    pub fn passkey_for_authentication(
        &self,
        credential_id: &str,
        origin: &str,
    ) -> Result<Value, StateError> {
        let mut matches: Vec<Value> = self
            .active_passkeys(origin)?
            .into_iter()
            .filter(|record| json::get_str(record, "credential_id") == Some(credential_id))
            .collect();
        if matches.len() != 1 {
            return Err(StateError::Passkey(PasskeyError::Unavailable(
                "invalid passkey authentication",
            )));
        }
        Ok(matches.remove(0))
    }

    /// Persists one verified credential and rotates every session, journaling it first; returns the new secret.
    ///
    /// # Errors
    ///
    /// Returns [`PasskeyError::Conflict`] when the factors changed or the credential is unavailable.
    pub fn add_passkey(
        &self,
        record: &Value,
        expected_generation: i64,
        journal: Journal<'_, String>,
    ) -> Result<String, StateError> {
        validated_passkey(record).map_err(StateError::Passkey)?;
        self.mutate(
            |data| {
                let conflict = |message| StateError::Passkey(PasskeyError::Conflict(message));
                if authentication_state(data)? != AuthState::Configured
                    || generation(data) != expected_generation
                {
                    return Err(conflict("authentication factors changed; retry"));
                }
                let records = validated_passkeys(data.get("passkeys").unwrap_or(&Value::Null))
                    .map_err(StateError::Passkey)?;
                let mut active: Vec<Value> = records
                    .iter()
                    .filter(|current| json::get_str(current, "status") == Some("active"))
                    .cloned()
                    .collect();
                let identifier = json::get_str(record, "credential_id");
                if active.len() >= MAX_PASSKEYS
                    || active
                        .iter()
                        .any(|current| json::get_str(current, "credential_id") == identifier)
                {
                    return Err(conflict("passkey is unavailable"));
                }
                active.push(record.clone());
                json::set(data, "passkeys", Value::Array(active));
                json::set(
                    data,
                    "factor_generation",
                    json::int(expected_generation + 1),
                );
                let secret = new_secret();
                json::set(data, "session_secret", json::text(&secret));
                Ok(secret)
            },
            |_| true,
            Some(journal),
        )
    }

    /// Commits one assertion against the exact original record, journaling its outcome first: a counter regression or
    /// backup-identity change suspends the passkey and rotates every session; a sign-in assertion completes a sign-in.
    ///
    /// # Errors
    ///
    /// Returns [`PasskeyError::Conflict`] when the factors or the credential changed.
    pub fn commit_passkey_authentication(
        &self,
        original: &Value,
        result: &Authentication,
        expected_generation: i64,
        sign_in: bool,
        journal: Journal<'_, PasskeyCommit>,
    ) -> Result<PasskeyCommit, StateError> {
        validated_passkey(original).map_err(StateError::Passkey)?;
        let now = self.now();
        self.mutate(
            |data| commit_assertion(data, original, result, expected_generation, sign_in, now),
            |_| true,
            Some(journal),
        )
    }
}

fn commit_assertion(
    data: &mut Value,
    original: &Value,
    result: &Authentication,
    expected_generation: i64,
    sign_in: bool,
    now: i64,
) -> Result<PasskeyCommit, StateError> {
    let conflict = |message| StateError::Passkey(PasskeyError::Conflict(message));
    if authentication_state(data)? != AuthState::Configured
        || generation(data) != expected_generation
    {
        return Err(conflict("authentication factors changed; retry"));
    }
    let records = validated_passkeys(data.get("passkeys").unwrap_or(&Value::Null))
        .map_err(StateError::Passkey)?;
    let matches: Vec<usize> = records
        .iter()
        .enumerate()
        .filter(|(_, record)| {
            json::get_str(record, "credential_id") == Some(result.credential_id.as_str())
        })
        .map(|(index, _)| index)
        .collect();
    let [index] = matches.as_slice() else {
        return Err(conflict("passkey changed; retry"));
    };
    if !json::equal(&records[*index], original) {
        return Err(conflict("passkey changed; retry"));
    }
    let (record, reason) = applied_assertion(&records[*index], result, now);
    let index = *index;
    if let Some(Value::Array(list)) = member_mut(data, "passkeys") {
        list[index] = record;
    }
    if reason.is_some() {
        json::set(
            data,
            "factor_generation",
            json::int(expected_generation + 1),
        );
        let secret = new_secret();
        json::set(data, "session_secret", json::text(&secret));
        return Ok((secret, reason));
    }
    if sign_in {
        signed_in(data);
    }
    Ok((
        json::get_str(data, "session_secret")
            .unwrap_or_default()
            .to_owned(),
        None,
    ))
}

/// The stored passkey after one verified assertion, and why the assertion suspends it: a signature counter that did not
/// advance, or a backup flag that is not the one it registered with.
fn applied_assertion(
    stored: &Value,
    result: &Authentication,
    now: i64,
) -> (Value, Option<&'static str>) {
    let sign_count = stored.get("sign_count").and_then(json::as_int).unwrap_or(0);
    let eligible = matches!(stored.get("backup_eligible"), Some(Value::Bool(true)));
    let counter_regressed = sign_count > 0 && result.new_sign_count <= sign_count;
    let identity_changed =
        result.backup_eligible != eligible || (result.backup_state && !result.backup_eligible);
    let mut record = stored.clone();
    json::set(&mut record, "last_used_at", json::int(now));
    json::set(&mut record, "updated_at", json::int(now));
    let reason = if counter_regressed {
        Some("counter-regression")
    } else if identity_changed {
        Some("backup-identity-change")
    } else {
        None
    };
    if reason.is_some() {
        json::set(&mut record, "status", json::text("suspended"));
    } else {
        json::set(&mut record, "sign_count", json::int(result.new_sign_count));
        json::set(
            &mut record,
            "backup_state",
            Value::Bool(result.backup_state),
        );
    }
    (record, reason)
}
