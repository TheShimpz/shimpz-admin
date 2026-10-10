"""The reproducible generation of the Supervisor common-password blocklist from its pinned corpus."""

import hashlib
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))

from signin import auth
from signin.blocklist import generate

# A tiny corpus: short entries, a duplicate in another case and width, the corpus's hex form (valid and not UTF-8 text).
CORPUS = "\n".join(
    (
        "123456",
        "passwordpassword",
        "PasswordPassword",
        "ｐａｓｓｗｏｒｄｐａｓｓｗｏｒｄ",
        "  spaced   out   phrase  ",
        "$HEX[636f6e7472617365c3b161636f6e7472617365c3b161]",
        "$HEX[ff]",
        "$HEX[zz]",
    )
).encode("utf-8")


class BlocklistGenerationTests(unittest.TestCase):
    def test_entries_are_unique_sorted_policy_forms_at_the_minimum_length(self) -> None:
        self.assertEqual(
            generate.entries(CORPUS),
            ["contraseñacontraseña", "passwordpassword", "spaced out phrase"],
        )

    def test_generation_writes_the_verified_corpus_one_entry_per_line(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = CORPUS
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "passwords.txt"
            with (
                mock.patch.object(generate, "SOURCE_SHA256", hashlib.sha256(CORPUS).hexdigest()),
                mock.patch.object(auth, "BLOCKLIST_PATH", output),
                mock.patch.object(generate.urllib.request, "urlopen", return_value=response) as urlopen,
            ):
                generate.main()

            written = output.read_text(encoding="utf-8")

        self.assertTrue(urlopen.call_args.args[0].startswith("https://raw.githubusercontent.com/danielmiessler/"))
        self.assertEqual(written, "contraseñacontraseña\npasswordpassword\nspaced out phrase\n")

    def test_a_corpus_with_another_digest_is_refused_without_writing(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = CORPUS
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "passwords.txt"
            with (
                mock.patch.object(auth, "BLOCKLIST_PATH", output),
                mock.patch.object(generate.urllib.request, "urlopen", return_value=response),
                self.assertRaisesRegex(SystemExit, "source digest mismatch"),
            ):
                generate.main()

            self.assertFalse(output.exists())

    def test_running_the_script_fetches_the_pinned_source(self) -> None:
        with (
            mock.patch("urllib.request.urlopen", side_effect=OSError("offline")),
            self.assertRaisesRegex(OSError, "offline"),
        ):
            runpy.run_path(str(Path(generate.__file__)), run_name="__main__")


if __name__ == "__main__":
    unittest.main()
