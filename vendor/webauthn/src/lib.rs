//! `WebAuthn`: the strict credential verifier, its stored key templates, and the canonical CBOR it reads, for one
//! relying party its consumer names (Account's Creator sign-in, the Local Admin's Supervisor).

pub mod cbor;
mod encoding;
pub mod keys;
pub mod verify;

#[cfg(any(test, feature = "testing"))]
pub mod testing;
#[cfg(test)]
mod tests;
