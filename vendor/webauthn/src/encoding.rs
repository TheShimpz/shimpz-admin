//! The strict unpadded base64url credentials carry.

const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Base64url, unpadded when `padded` is false.
#[must_use]
pub fn base64url(bytes: &[u8], padded: bool) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = u32::from(chunk[0]) << 16
            | u32::from(*chunk.get(1).unwrap_or(&0)) << 8
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let symbols = chunk.len() + 1;
        for index in 0..4 {
            if index < symbols {
                out.push(char::from(
                    BASE64URL[((value >> (18 - 6 * index)) & 63) as usize],
                ));
            } else if padded {
                out.push('=');
            }
        }
    }
    out
}

fn symbol(byte: u8) -> Option<u32> {
    BASE64URL
        .iter()
        .position(|&candidate| candidate == byte)
        .map(|index| u32::try_from(index).unwrap_or(0))
}

/// The bytes of base64url `text` in exactly the spelling [`base64url`] writes for them (padded when `padded`), or
/// `None` for any other spelling: another alphabet, wrong or missing padding, a dangling symbol, or non-zero
/// unused trailing bits.
#[must_use]
pub fn unbase64url(text: &str, padded: bool) -> Option<Vec<u8>> {
    let body = if padded {
        if !text.len().is_multiple_of(4) {
            return None;
        }
        text.trim_end_matches('=')
    } else {
        text
    };
    if text.len() - body.len() > 2 || body.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    for chunk in body.as_bytes().chunks(4) {
        let mut value = 0_u32;
        for (index, &byte) in chunk.iter().enumerate() {
            value |= symbol(byte)? << (18 - 6 * index);
        }
        let bytes = value.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    (base64url(&out, padded) == text).then_some(out)
}
