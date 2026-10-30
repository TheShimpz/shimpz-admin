//! The three stored credential-key templates: the exact CTAP2 canonical COSE encodings of an ES256 key (a valid
//! P-256 point), an `EdDSA` (`Ed25519`) key, and an RS256 key (a 2,048 to 4,096-bit odd modulus without a leading zero
//! byte, exponent 65537). Any other algorithm, curve, size, member, or encoding is not a key Account stores.

use ring::signature::{self, RsaPublicKeyComponents, UnparsedPublicKey};

/// COSE ES256.
pub const ES256: i64 = -7;
/// COSE `EdDSA`.
pub const EDDSA: i64 = -8;
/// COSE RS256.
pub const RS256: i64 = -257;

const ES256_PREFIX: [u8; 10] = [0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20];
const ES256_Y_PREFIX: [u8; 3] = [0x22, 0x58, 0x20];
const EDDSA_PREFIX: [u8; 10] = [0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06, 0x21, 0x58, 0x20];
const RS256_PREFIX: [u8; 9] = [0xa4, 0x01, 0x03, 0x03, 0x39, 0x01, 0x00, 0x20, 0x59];
const RS256_EXPONENT: [u8; 5] = [0x21, 0x43, 0x01, 0x00, 0x01];

/// One decoded credential key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoredKey {
    /// An uncompressed P-256 point.
    Es256(Vec<u8>),
    /// An Ed25519 public key.
    EdDsa(Vec<u8>),
    /// An RSA modulus (exponent 65537).
    Rs256(Vec<u8>),
}

impl StoredKey {
    /// The COSE algorithm the key signs with.
    #[must_use]
    pub fn algorithm(&self) -> i64 {
        match self {
            Self::Es256(_) => ES256,
            Self::EdDsa(_) => EDDSA,
            Self::Rs256(_) => RS256,
        }
    }

    /// The algorithm's name.
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::Es256(_) => "ES256",
            Self::EdDsa(_) => "EdDSA",
            Self::Rs256(_) => "RS256",
        }
    }

    /// Whether `signature` signs `message` under this key (ES256: strict DER; RS256: as long as the modulus).
    #[must_use]
    pub fn verifies(&self, message: &[u8], signature_bytes: &[u8]) -> bool {
        match self {
            Self::Es256(point) => UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_ASN1, point)
                .verify(message, signature_bytes)
                .is_ok(),
            Self::EdDsa(key) => UnparsedPublicKey::new(&signature::ED25519, key)
                .verify(message, signature_bytes)
                .is_ok(),
            Self::Rs256(modulus) => {
                signature_bytes.len() == modulus.len()
                    && RsaPublicKeyComponents {
                        n: modulus.as_slice(),
                        e: &[1_u8, 0, 1][..],
                    }
                    .verify(
                        &signature::RSA_PKCS1_2048_8192_SHA256,
                        message,
                        signature_bytes,
                    )
                    .is_ok()
            }
        }
    }
}

/// The template length of the key starting at `data[0]`, when its prefix names one.
#[must_use]
pub fn template_length(data: &[u8]) -> Option<usize> {
    if data.starts_with(&ES256_PREFIX) {
        Some(77)
    } else if data.starts_with(&EDDSA_PREFIX) {
        Some(42)
    } else if data.starts_with(&RS256_PREFIX) && data.len() >= 11 {
        Some(
            RS256_PREFIX.len()
                + 2
                + usize::from(u16::from_be_bytes([data[9], data[10]]))
                + RS256_EXPONENT.len(),
        )
    } else {
        None
    }
}

/// The key a stored COSE encoding holds, or `None` for anything but an admitted template.
#[must_use]
pub fn decode(cose: &[u8]) -> Option<StoredKey> {
    if cose.starts_with(&ES256_PREFIX) {
        if cose.len() != 77 || cose[42..45] != ES256_Y_PREFIX {
            return None;
        }
        let point = [&[0x04][..], &cose[10..42], &cose[45..77]].concat();
        p256::PublicKey::from_sec1_bytes(&point).ok()?;
        return Some(StoredKey::Es256(point));
    }
    if cose.starts_with(&EDDSA_PREFIX) {
        return (cose.len() == 42).then(|| StoredKey::EdDsa(cose[10..].to_vec()));
    }
    if cose.starts_with(&RS256_PREFIX) && cose.len() >= 11 {
        let length = usize::from(u16::from_be_bytes([cose[9], cose[10]]));
        let modulus = cose.get(11..11 + length)?;
        let bits = modulus.first().map_or(0, |&first| {
            (modulus.len() * 8) - first.leading_zeros() as usize
        });
        let admitted = cose.get(11 + length..) == Some(&RS256_EXPONENT[..])
            && modulus.first().is_some_and(|&first| first != 0)
            && modulus.last().is_some_and(|&last| last % 2 == 1)
            && (2048..=4096).contains(&bits);
        return admitted.then(|| StoredKey::Rs256(modulus.to_vec()));
    }
    None
}
