"""The mirrored Team HTTP protocol verifier refuses drifted canonical JSON, rerun literal, and URL vectors."""

import unittest

from test_protocol_verifier_edges import HTTP, _execute, _rewrite_json


class TeamHttpVerifierVectorTests(unittest.TestCase):
    def _assert_vector_mutations_refused(self, *mutations: object) -> None:
        """The mirrored verifier refuses vectors.json after each one of these mutations."""
        for mutate in mutations:
            with self.subTest(mutate=mutate), self.assertRaises(SystemExit):
                _execute(
                    HTTP / "verify.py", lambda root, mutation=mutate: _rewrite_json(root, "vectors.json", mutation)
                )

    def test_rejects_missing_or_drifted_routine_rerun_literal_vectors(self) -> None:
        def missing(value: dict[str, object]) -> None:
            value.pop("routine_rerun_literal")

        def refused_valid(value: dict[str, object]) -> None:
            value["routine_rerun_literal"]["valid"].append("1e16")

        def admitted_invalid(value: dict[str, object]) -> None:
            value["routine_rerun_literal"]["invalid"].append("1e+16")

        self._assert_vector_mutations_refused(missing, refused_valid, admitted_invalid)

    def test_rejects_missing_or_drifted_canonical_json_vectors(self) -> None:
        def missing(value: dict[str, object]) -> None:
            value["canonical_json"]["dumps"] = []

        def drifted_bytes(value: dict[str, object]) -> None:
            value["canonical_json"]["canonical"][0]["utf8"] = "0"

        def drifted_options(value: dict[str, object]) -> None:
            value["canonical_json"]["dumps"][0]["text"] += " "

        def drifted_size(value: dict[str, object]) -> None:
            value["canonical_json"]["encoded_bytes"][0]["bytes"] += 1

        def drifted_record(value: dict[str, object]) -> None:
            case = next(case for case in value["canonical_json"]["encode_record"] if case["line"] is not None)
            case["line"] = None

        def refused_record(value: dict[str, object]) -> None:
            case = next(case for case in value["canonical_json"]["encode_record"] if case["line"] is None)
            case["line"] = "{}\n"

        self._assert_vector_mutations_refused(
            missing, drifted_bytes, drifted_options, drifted_size, drifted_record, refused_record
        )

    def test_rejects_missing_or_drifted_supervisor_claims_encoding_vectors(self) -> None:
        def missing(value: dict[str, object]) -> None:
            del value["canonical_json"]["claims_json"]

        def one_sided(value: dict[str, object]) -> None:
            claims = value["canonical_json"]["claims_json"]
            claims[:] = [case for case in claims if case["utf8"] is not None]

        def drifted(value: dict[str, object]) -> None:
            case = next(case for case in value["canonical_json"]["claims_json"] if case["utf8"] is not None)
            case["utf8"] += " "

        def admitted(value: dict[str, object]) -> None:
            case = next(case for case in value["canonical_json"]["claims_json"] if case["utf8"] is None)
            case["utf8"] = "{}"

        self._assert_vector_mutations_refused(missing, one_sided, drifted, admitted)

    def test_rejects_missing_or_drifted_url_canonicalization_vectors(self) -> None:
        def section(change):
            return lambda value: change(value["url_canonicalization"])

        def drift(field: str, replacement: object):
            def change(group: dict[str, object]) -> None:
                group["named"][-1][field] = replacement

            return section(change)

        self._assert_vector_mutations_refused(
            section(lambda group: group.update({"named": []})),
            section(lambda group: group.update({"corpus": []})),
            drift("origin", "https://example.com"),
            drift("browser_url", "https://example.com/"),
            drift("start_site", "example.com"),
        )


if __name__ == "__main__":
    unittest.main()
