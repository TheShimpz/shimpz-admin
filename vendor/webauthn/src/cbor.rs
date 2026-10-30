//! Canonical CBOR as `WebAuthn` authenticators write it (`CTAP2`): definite lengths, shortest arguments, map keys strictly
//! increasing by encoded length then bytes (so no duplicate), keys that are integers or strings, and only integers,
//! byte and text strings, arrays, maps, `false`, `true`, and `null`. Floats, tags, and every other simple value are
//! refused, as is nesting deeper than [`MAX_DEPTH`].

/// The deepest nesting admitted.
pub const MAX_DEPTH: usize = 400;

/// One decoded item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Item {
    /// An integer.
    Int(i128),
    /// A byte string.
    Bytes(Vec<u8>),
    /// A text string.
    Text(String),
    /// An array.
    Array(Vec<Item>),
    /// A map, in its (canonical) order.
    Map(Vec<(Item, Item)>),
    /// `false` or `true`.
    Bool(bool),
    /// `null`.
    Null,
}

impl Item {
    /// The value of the map member keyed by text `name`.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&Item> {
        match self {
            Self::Map(members) => members
                .iter()
                .find(|(key, _)| *key == Self::Text(name.into()))
                .map(|(_, value)| value),
            _ => None,
        }
    }

    /// The names of a map keyed by text, in order.
    #[must_use]
    pub fn text_keys(&self) -> Option<Vec<&str>> {
        match self {
            Self::Map(members) => members
                .iter()
                .map(|(key, _)| match key {
                    Self::Text(name) => Some(name.as_str()),
                    _ => None,
                })
                .collect(),
            _ => None,
        }
    }
}

struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl Reader<'_> {
    fn take(&mut self, count: usize) -> Option<&[u8]> {
        let end = self.offset.checked_add(count)?;
        let slice = self.data.get(self.offset..end)?;
        self.offset = end;
        Some(slice)
    }

    fn argument(&mut self, info: u8) -> Option<u64> {
        let (value, minimum) = match info {
            0..=23 => return Some(u64::from(info)),
            24 => (u64::from(self.take(1)?[0]), 24),
            25 => (
                u64::from(u16::from_be_bytes(self.take(2)?.try_into().ok()?)),
                1 << 8,
            ),
            26 => (
                u64::from(u32::from_be_bytes(self.take(4)?.try_into().ok()?)),
                1 << 16,
            ),
            27 => (u64::from_be_bytes(self.take(8)?.try_into().ok()?), 1 << 32),
            _ => return None,
        };
        (value >= minimum).then_some(value)
    }

    fn item(&mut self, depth: usize) -> Option<Item> {
        if depth > MAX_DEPTH {
            return None;
        }
        let initial = self.take(1)?[0];
        let (major, info) = (initial >> 5, initial & 0x1f);
        if major == 7 {
            return match info {
                20 => Some(Item::Bool(false)),
                21 => Some(Item::Bool(true)),
                22 => Some(Item::Null),
                _ => None,
            };
        }
        let argument = self.argument(info)?;
        match major {
            0 => Some(Item::Int(i128::from(argument))),
            1 => Some(Item::Int(-1 - i128::from(argument))),
            2 => Some(Item::Bytes(
                self.take(usize::try_from(argument).ok()?)?.to_vec(),
            )),
            3 => String::from_utf8(self.take(usize::try_from(argument).ok()?)?.to_vec())
                .ok()
                .map(Item::Text),
            4 => (0..argument)
                .map(|_| self.item(depth + 1))
                .collect::<Option<Vec<_>>>()
                .map(Item::Array),
            5 => self.map(argument, depth),
            _ => None,
        }
    }

    fn map(&mut self, count: u64, depth: usize) -> Option<Item> {
        let mut members = Vec::new();
        let mut previous: Option<&[u8]> = None;
        for _ in 0..count {
            let start = self.offset;
            let key = self.item(depth + 1)?;
            if !matches!(key, Item::Int(_) | Item::Bytes(_) | Item::Text(_)) {
                return None;
            }
            let encoded = &self.data[start..self.offset];
            if let Some(before) = previous
                && (before.len(), before) >= (encoded.len(), encoded)
            {
                return None;
            }
            previous = Some(encoded);
            members.push((key, self.item(depth + 1)?));
        }
        Some(Item::Map(members))
    }
}

/// One canonical item at the start of `data` and the bytes it took, or `None` for anything else.
#[must_use]
pub fn item_prefix(data: &[u8]) -> Option<(Item, usize)> {
    let mut reader = Reader { data, offset: 0 };
    let item = reader.item(0)?;
    Some((item, reader.offset))
}

/// Exactly one canonical item filling `data`.
#[must_use]
pub fn item(data: &[u8]) -> Option<Item> {
    item_prefix(data)
        .filter(|(_, used)| *used == data.len())
        .map(|(item, _)| item)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_canonical_cbor_decodes() {
        assert_eq!(
            item(&[0xa1, 0x61, 0x61, 0x01]),
            Some(Item::Map(vec![(Item::Text("a".into()), Item::Int(1))]))
        );
        assert_eq!(item(&[0x20]), Some(Item::Int(-1)));
        for bad in [
            &[0x18, 0x01][..],
            &[0xa2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x02],
            &[0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02],
            &[0xbf, 0x61, 0x61, 0x01, 0xff],
            &[0xf9, 0x3c, 0x00],
            &[0xc2, 0x41, 0x01],
            &[0xf7],
            &[0xa1, 0x80, 0x01],
            &[0x01, 0x00],
            &[0x62, 0xff, 0xfe],
        ] {
            assert_eq!(item(bad), None, "{bad:02x?}");
        }
        let deep: Vec<u8> = std::iter::repeat_n(0x81, 600).chain([0x00]).collect();
        assert_eq!(item(&deep), None);
    }
}
