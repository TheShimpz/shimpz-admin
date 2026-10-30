//! An emulated authenticator for tests: ES256, `EdDSA`, and RS256 credentials in Developers' exact shape.

use std::sync::OnceLock;

use ring::{
    digest,
    rand::SystemRandom,
    signature::{self, EcdsaKeyPair, Ed25519KeyPair, KeyPair as _, RsaKeyPair},
};
use strict_json::Value;

use crate::{cbor::Item, encoding::base64url, keys};

/// UP.
pub const UP: u8 = 0x01;
/// UV.
pub const UV: u8 = 0x04;
/// BE.
pub const BE: u8 = 0x08;
/// BS.
pub const BS: u8 = 0x10;
/// ED.
pub const ED: u8 = 0x80;

/// Canonical CBOR of `item`.
///
/// # Panics
///
/// An argument beyond 32 bits.
#[must_use]
pub fn encode(item: &Item) -> Vec<u8> {
    fn head(major: u8, argument: u64) -> Vec<u8> {
        match argument {
            0..=23 => vec![major << 5 | u8::try_from(argument).unwrap()],
            24..=0xff => vec![major << 5 | 0x18, u8::try_from(argument).unwrap()],
            0x100..=0xffff => [
                vec![major << 5 | 0x19],
                u16::try_from(argument).unwrap().to_be_bytes().to_vec(),
            ]
            .concat(),
            _ => [
                vec![major << 5 | 0x1a],
                u32::try_from(argument).unwrap().to_be_bytes().to_vec(),
            ]
            .concat(),
        }
    }
    match item {
        Item::Int(value) if *value >= 0 => head(0, u64::try_from(*value).unwrap()),
        Item::Int(value) => head(1, u64::try_from(-1 - value).unwrap()),
        Item::Bytes(bytes) => [head(2, bytes.len() as u64), bytes.clone()].concat(),
        Item::Text(text) => [head(3, text.len() as u64), text.as_bytes().to_vec()].concat(),
        Item::Array(items) => [
            head(4, items.len() as u64),
            items.iter().flat_map(encode).collect(),
        ]
        .concat(),
        Item::Map(members) => {
            let mut encoded: Vec<(Vec<u8>, Vec<u8>)> = members
                .iter()
                .map(|(key, value)| (encode(key), encode(value)))
                .collect();
            encoded.sort_by(|left, right| (left.0.len(), &left.0).cmp(&(right.0.len(), &right.0)));
            [
                head(5, members.len() as u64),
                encoded
                    .into_iter()
                    .flat_map(|(key, value)| [key, value].concat())
                    .collect(),
            ]
            .concat()
        }
        Item::Bool(flag) => vec![if *flag { 0xf5 } else { 0xf4 }],
        Item::Null => vec![0xf6],
    }
}

fn text(name: &str) -> Item {
    Item::Text(name.into())
}

fn rsa_pkcs1() -> &'static [u8] {
    static KEY: OnceLock<Vec<u8>> = OnceLock::new();
    KEY.get_or_init(|| {
        let output = std::process::Command::new("sh")
            .args(["-c", "openssl genrsa -traditional 2048 2>/dev/null | openssl rsa -traditional -outform DER 2>/dev/null"])
            .output()
            .expect("openssl generates the test RSA key");
        assert!(output.status.success() && !output.stdout.is_empty());
        output.stdout
    })
}

enum Signer {
    Es256(EcdsaKeyPair),
    EdDsa(Ed25519KeyPair),
    Rs256(RsaKeyPair),
}

/// One credential of one algorithm, at one relying party.
pub struct Authenticator {
    /// The credential id bytes.
    pub raw_id: Vec<u8>,
    signer: Signer,
    rp_id: String,
    origin: String,
}

impl Authenticator {
    /// A credential of `algorithm` (a COSE id) with `raw_id`, created at the RP ID `rp_id` from the page at `origin`.
    ///
    /// # Panics
    ///
    /// An unknown algorithm or an unusable test key.
    #[must_use]
    pub fn new(algorithm: i64, raw_id: &[u8], rp_id: &str, origin: &str) -> Self {
        let random = SystemRandom::new();
        let signer = match algorithm {
            keys::ES256 => {
                let pkcs8 = EcdsaKeyPair::generate_pkcs8(
                    &signature::ECDSA_P256_SHA256_ASN1_SIGNING,
                    &random,
                )
                .unwrap();
                Signer::Es256(
                    EcdsaKeyPair::from_pkcs8(
                        &signature::ECDSA_P256_SHA256_ASN1_SIGNING,
                        pkcs8.as_ref(),
                        &random,
                    )
                    .unwrap(),
                )
            }
            keys::EDDSA => Signer::EdDsa(Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap()),
            _ => Signer::Rs256(RsaKeyPair::from_der(rsa_pkcs1()).unwrap()),
        };
        Self {
            raw_id: raw_id.to_vec(),
            signer,
            rp_id: rp_id.to_owned(),
            origin: origin.to_owned(),
        }
    }

    /// The canonical base64url credential id.
    #[must_use]
    pub fn credential_id(&self) -> String {
        base64url(&self.raw_id, false)
    }

    /// The COSE key template.
    #[must_use]
    pub fn cose(&self) -> Vec<u8> {
        let members = match &self.signer {
            Signer::Es256(pair) => {
                let point = pair.public_key().as_ref();
                vec![
                    (Item::Int(1), Item::Int(2)),
                    (Item::Int(3), Item::Int(-7)),
                    (Item::Int(-1), Item::Int(1)),
                    (Item::Int(-2), Item::Bytes(point[1..33].to_vec())),
                    (Item::Int(-3), Item::Bytes(point[33..].to_vec())),
                ]
            }
            Signer::EdDsa(pair) => vec![
                (Item::Int(1), Item::Int(1)),
                (Item::Int(3), Item::Int(-8)),
                (Item::Int(-1), Item::Int(6)),
                (
                    Item::Int(-2),
                    Item::Bytes(pair.public_key().as_ref().to_vec()),
                ),
            ],
            Signer::Rs256(pair) => vec![
                (Item::Int(1), Item::Int(3)),
                (Item::Int(3), Item::Int(-257)),
                (
                    Item::Int(-1),
                    Item::Bytes(
                        signature::RsaPublicKeyComponents::<Vec<u8>>::from(pair.public()).n,
                    ),
                ),
                (Item::Int(-2), Item::Bytes(vec![1, 0, 1])),
            ],
        };
        encode(&Item::Map(members))
    }

    /// The algorithm's COSE id.
    #[must_use]
    pub fn algorithm(&self) -> i64 {
        match self.signer {
            Signer::Es256(_) => keys::ES256,
            Signer::EdDsa(_) => keys::EDDSA,
            Signer::Rs256(_) => keys::RS256,
        }
    }

    /// The signature of `message`.
    ///
    /// # Panics
    ///
    /// Signing fails.
    #[must_use]
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        let random = SystemRandom::new();
        match &self.signer {
            Signer::Es256(pair) => pair.sign(&random, message).unwrap().as_ref().to_vec(),
            Signer::EdDsa(pair) => pair.sign(message).as_ref().to_vec(),
            Signer::Rs256(pair) => {
                let mut out = vec![0; pair.public().modulus_len()];
                pair.sign(&signature::RSA_PKCS1_SHA256, &random, message, &mut out)
                    .unwrap();
                out
            }
        }
    }

    /// clientDataJSON of one ceremony with the given origin and an extra member.
    #[must_use]
    pub fn client_data(ceremony: &str, challenge: &str, origin: &str, extra: &str) -> Vec<u8> {
        format!(r#"{{"type": "{ceremony}", "challenge": "{challenge}", "origin": "{origin}", "crossOrigin": false{extra}}}"#)
            .into_bytes()
    }

    fn rp_hash(&self) -> Vec<u8> {
        digest::digest(&digest::SHA256, self.rp_id.as_bytes())
            .as_ref()
            .to_vec()
    }

    /// A registration credential; `packed` signs a self-attestation, `tail` follows the key in the data.
    ///
    /// # Panics
    ///
    /// A credential id over 65,535 bytes.
    #[must_use]
    pub fn register(
        &self,
        challenge: &str,
        flags: u8,
        packed: bool,
        client: Option<Vec<u8>>,
        tail: &[u8],
    ) -> Value {
        let client = client
            .unwrap_or_else(|| Self::client_data("webauthn.create", challenge, &self.origin, ""));
        let data = [
            self.rp_hash(),
            vec![flags | 0x40],
            vec![0; 4],
            vec![0; 16],
            u16::try_from(self.raw_id.len())
                .unwrap()
                .to_be_bytes()
                .to_vec(),
            self.raw_id.clone(),
            self.cose(),
            tail.to_vec(),
        ]
        .concat();
        let statement = if packed {
            let signed = [
                data.as_slice(),
                digest::digest(&digest::SHA256, &client).as_ref(),
            ]
            .concat();
            Item::Map(vec![
                (text("alg"), Item::Int(i128::from(self.algorithm()))),
                (text("sig"), Item::Bytes(self.sign(&signed))),
            ])
        } else {
            Item::Map(Vec::new())
        };
        let format = if packed { "packed" } else { "none" };
        let attestation = encode(&Item::Map(vec![
            (text("fmt"), text(format)),
            (text("attStmt"), statement),
            (text("authData"), Item::Bytes(data)),
        ]));
        self.credential(vec![
            (
                "attestationObject",
                Value::String(base64url(&attestation, false)),
            ),
            ("clientDataJSON", Value::String(base64url(&client, false))),
        ])
    }

    /// An assertion credential with `sign_count` and `flags`.
    #[must_use]
    pub fn assertion(
        &self,
        challenge: &str,
        sign_count: u32,
        flags: u8,
        handle: Option<&[u8]>,
    ) -> Value {
        let client = Self::client_data("webauthn.get", challenge, &self.origin, "");
        let data = [
            self.rp_hash(),
            vec![flags],
            sign_count.to_be_bytes().to_vec(),
        ]
        .concat();
        let signed = [
            data.as_slice(),
            digest::digest(&digest::SHA256, &client).as_ref(),
        ]
        .concat();
        self.credential(vec![
            ("authenticatorData", Value::String(base64url(&data, false))),
            ("clientDataJSON", Value::String(base64url(&client, false))),
            (
                "signature",
                Value::String(base64url(&self.sign(&signed), false)),
            ),
            (
                "userHandle",
                handle.map_or(Value::Null, |bytes| Value::String(base64url(bytes, false))),
            ),
        ])
    }

    fn credential(&self, response: Vec<(&str, Value)>) -> Value {
        Value::Object(vec![
            ("authenticatorAttachment".into(), Value::Null),
            ("clientExtensionResults".into(), Value::Object(Vec::new())),
            ("id".into(), Value::String(self.credential_id())),
            ("rawId".into(), Value::String(self.credential_id())),
            (
                "response".into(),
                Value::Object(
                    response
                        .into_iter()
                        .map(|(name, value)| (name.into(), value))
                        .collect(),
                ),
            ),
            ("type".into(), Value::String("public-key".into())),
        ])
    }
}
