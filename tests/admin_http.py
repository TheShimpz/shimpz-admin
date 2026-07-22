"""Shared real-HTTP harness for Admin integration contracts."""

from __future__ import annotations

import http.client
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"


def request(
    port: int,
    method: str,
    path: str,
    body: dict[str, object] | None = None,
    *,
    session: str | None = None,
    timeout: float = 10,
) -> tuple[int, object, str]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    headers = {"Content-Type": "application/json"}
    if session is not None:
        headers["Cookie"] = f"shimpz_admin={session}"
    connection.request(method, path, json.dumps(body) if body is not None else None, headers)
    response = connection.getresponse()
    raw = response.read().decode("utf-8", errors="replace")
    set_cookie = response.getheader("Set-Cookie") or ""
    connection.close()
    try:
        payload: object = json.loads(raw)
    except json.JSONDecodeError:
        payload = raw
    return response.status, payload, set_cookie


def session_cookie(set_cookie: str) -> str | None:
    match = re.search(r"shimpz_admin=([^;]+)", set_cookie)
    return match.group(1) if match else None


class AdminHTTPServer:
    def __init__(self, root: Path, **environment: str) -> None:
        self.root = root
        self.environment = environment
        self.port = self._free_port()
        self.process: subprocess.Popen[str] | None = None

    @staticmethod
    def _free_port() -> int:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            return int(listener.getsockname()[1])

    def __enter__(self) -> AdminHTTPServer:
        self.process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(self.port),
                "--log-level",
                "warning",
            ],
            cwd=BACKEND,
            env={
                **os.environ,
                "SHIMPZ_REPO": str(self.root),
                "SHIMPZ_ADMIN_STORE": str(self.root / "admin.json"),
                **self.environment,
            },
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    output = self.process.stdout.read() if self.process.stdout else ""
                    raise RuntimeError(f"Admin HTTP server exited during startup:\n{output[-2000:]}")
                try:
                    if request(self.port, "GET", "/api/session", timeout=1)[0] == 200:
                        return self
                except OSError:
                    time.sleep(0.05)
            raise RuntimeError("Admin HTTP server did not become ready within 30 seconds")
        except Exception:
            self._stop()
            raise

    def __exit__(self, _type, _value, _traceback) -> None:
        self._stop()

    def _stop(self) -> None:
        if self.process is None:
            return
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        if self.process.stdout is not None:
            self.process.stdout.close()
        self.process = None
