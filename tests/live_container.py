"""Live contract for credential persistence in the shipped read-only Admin image."""

from __future__ import annotations

import os
import shlex
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from admin_http import request, session_cookie

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
IMAGE = "shimpz-admin:local"
PASSWORD = " ".join(("correct", "horse", "battery"))
ADMIN_UID = 1000
ADMIN_GID = 1000
CONTAINER_TEMP = Path("/") / "tmp"


class DockerCLI:
    def __init__(self) -> None:
        self._use_group_shell = False

    def available(self) -> bool:
        direct = subprocess.run(["docker", "info"], capture_output=True, text=True, check=False)
        if direct.returncode == 0:
            return True
        if shutil.which("sg") is None:
            return False
        grouped = subprocess.run(
            ["sg", "docker", "-c", "docker info"],
            capture_output=True,
            text=True,
            check=False,
        )
        self._use_group_shell = grouped.returncode == 0
        return self._use_group_shell

    def run(self, *arguments: str, timeout: int = 60) -> subprocess.CompletedProcess[str]:
        command = ["docker", *arguments]
        if self._use_group_shell:
            command = ["sg", "docker", "-c", shlex.join(command)]
        return subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)


class ReadOnlyAdminContainerTests(unittest.TestCase):
    def test_real_image_persists_configuration_through_the_single_file_mount(self) -> None:
        docker = DockerCLI()
        if not docker.available():
            self._require_or_skip("Docker is unavailable")
        if docker.run("image", "inspect", IMAGE).returncode != 0:
            self._require_or_skip(f"{IMAGE} is unavailable")

        identity = f"shimpz-admin-ro-{os.getpid()}"
        container = identity
        volume = f"{identity}-data"
        with tempfile.TemporaryDirectory(prefix="shimpz-admin-container-") as directory:
            root = Path(directory)
            env_path = root / ".env"
            env_path.write_text("", encoding="utf-8")
            env_path.chmod(0o600)
            port = self._free_port()
            docker.run("rm", "--force", container)
            docker.run("volume", "rm", "--force", volume)
            created = docker.run("volume", "create", volume)
            self.assertEqual(created.returncode, 0, created.stderr)
            try:
                self._prepare_env_owner(docker, env_path)
                self._start_container(docker, container, volume, env_path, port)
                self._wait_until_ready(docker, container, port)
                self._exercise_persistence(docker, container, env_path, port)
            finally:
                docker.run("rm", "--force", container)
                docker.run("volume", "rm", "--force", volume)

    def _require_or_skip(self, reason: str) -> None:
        if os.environ.get("SHIMPZ_TEST_ALL") == "1":
            self.fail(reason)
        self.skipTest(reason)

    @staticmethod
    def _free_port() -> int:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            return int(listener.getsockname()[1])

    def _prepare_env_owner(self, docker: DockerCLI, env_path: Path) -> None:
        prepared = docker.run(
            "run",
            "--rm",
            "--read-only",
            "--network",
            "none",
            "--cap-drop",
            "ALL",
            "--cap-add",
            "CHOWN",
            "--security-opt",
            "no-new-privileges:true",
            "--user",
            "0:0",
            "--entrypoint",
            "chown",
            "--volume",
            f"{env_path}:/fixture/.env",
            IMAGE,
            f"{ADMIN_UID}:{ADMIN_GID}",
            "/fixture/.env",
        )
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        owner = docker.run(
            "run",
            "--rm",
            "--read-only",
            "--network",
            "none",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--user",
            f"{ADMIN_UID}:{ADMIN_GID}",
            "--entrypoint",
            "stat",
            "--volume",
            f"{env_path}:/fixture/.env:ro",
            IMAGE,
            "-c",
            "%u:%g %a",
            "/fixture/.env",
        )
        self.assertEqual(owner.returncode, 0, owner.stderr)
        self.assertEqual(owner.stdout.strip(), f"{ADMIN_UID}:{ADMIN_GID} 600")

    def _start_container(
        self,
        docker: DockerCLI,
        container: str,
        volume: str,
        env_path: Path,
        port: int,
    ) -> None:
        started = docker.run(
            "run",
            "--detach",
            "--name",
            container,
            "--read-only",
            "--tmpfs",
            f"{CONTAINER_TEMP}:size=32m,mode=1777",
            "--security-opt",
            "no-new-privileges:true",
            "--user",
            f"{ADMIN_UID}:{ADMIN_GID}",
            "--publish",
            f"127.0.0.1:{port}:4600",
            "--volume",
            f"{env_path}:/repo/.env",
            "--volume",
            f"{volume}:/data",
            "--volume",
            f"{BACKEND}:/app/backend:ro",
            IMAGE,
        )
        self.assertEqual(started.returncode, 0, started.stderr)

    def _wait_until_ready(self, docker: DockerCLI, container: str, port: int) -> None:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                if request(port, "GET", "/api/session", timeout=1)[0] == 200:
                    return
            except OSError:
                time.sleep(0.1)
        logs = docker.run("logs", container).stdout
        self.fail(f"read-only Admin did not become ready:\n{logs[-4000:]}")

    def _exercise_persistence(self, docker: DockerCLI, container: str, env_path: Path, port: int) -> None:
        self.assertEqual(request(port, "GET", "/api/state")[0], 401)
        status, payload, set_cookie = request(
            port,
            "POST",
            "/api/admin/setup",
            {"password": PASSWORD},
        )
        session = session_cookie(set_cookie)
        self.assertEqual((status, payload), (200, {"ok": True}))
        self.assertIsNotNone(session)

        applied = request(
            port,
            "POST",
            "/api/apply",
            {"values": {"KASM_USER": "ro-test-user"}},
            session=session,
        )
        self.assertEqual((applied[0], applied[1]["applied"]), (200, True))
        readback = docker.run(
            "run",
            "--rm",
            "--read-only",
            "--network",
            "none",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--user",
            f"{ADMIN_UID}:{ADMIN_GID}",
            "--entrypoint",
            "cat",
            "--volume",
            f"{env_path}:/fixture/.env:ro",
            IMAGE,
            "/fixture/.env",
        )
        self.assertEqual(readback.returncode, 0, readback.stderr)
        self.assertIn("KASM_USER=ro-test-user", readback.stdout)
        self.assertIn("POSTGRES_PASSWORD=", readback.stdout)

        logs = docker.run("logs", container)
        combined = f"{logs.stdout}{logs.stderr}"
        self.assertNotIn("Traceback", combined)
        self.assertNotIn("EROFS", combined)


if __name__ == "__main__":
    unittest.main()
