use super::*;

#[test]
fn every_protocol_method_has_exactly_one_operation() {
    for (method, _, _) in frames::METHODS {
        assert_eq!(
            HANDLERS.iter().filter(|(name, _)| name == method).count(),
            1,
            "{method}"
        );
    }
    assert_eq!(HANDLERS.len(), frames::METHODS.len());
}
