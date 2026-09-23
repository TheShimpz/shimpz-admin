"""Run the Assistants benchmark against a fresh, isolated Local Admin image.

Build the current Admin image as shimpz-admin:perf first. If the shell has not
inherited Docker group membership, run this entrypoint through ``sg docker``.
The browser shares only the disposable Admin's loopback network namespace.
"""

import json
import os
import subprocess
import time
import uuid
from pathlib import Path

ADMIN_IMAGE = os.environ.get("SHIMPZ_PERF_ADMIN_IMAGE", "shimpz-admin:perf")
BROWSER_IMAGE = "mcr.microsoft.com/playwright:v1.62.0-noble"
FRONTEND = Path(__file__).resolve().parent.parent
CONTAINER_TEMP_DIR = Path("/") / "tmp"
ADMIN_CPUS = 2
ADMIN_MEMORY_MIB = 512
BROWSER_CPUS = 2
BROWSER_MEMORY_MIB = 2048


def docker(*arguments: str, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["docker", *arguments], capture_output=True, text=True, timeout=timeout, check=False)


def required_docker(*arguments: str, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    result = docker(*arguments, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"Docker {arguments[0]} failed; inspect the Docker daemon.")
    return result


def inspect_optional(kind: str, name: str, field: str) -> str | None:
    result = docker(kind, "inspect", name, "--format", field)
    if result.returncode == 0:
        return result.stdout.strip()
    listing = required_docker(
        kind,
        "ls",
        *(["--all"] if kind == "container" else []),
        "--format",
        "{{.Names}}" if kind == "container" else "{{.Name}}",
    )
    if name in listing.stdout.splitlines():
        raise RuntimeError(f"Docker {kind} inspect failed; cleanup state is unknown.")
    return None


def require_unused(kind: str, name: str) -> None:
    if inspect_optional(kind, name, "{{.Name}}") is not None:
        raise RuntimeError(f"Disposable {kind} name is already in use.")


def owned_cleanup(container: str, volume: str, identity: str) -> None:
    container_label = inspect_optional("container", container, '{{index .Config.Labels "shimpz.perf.run"}}')
    if container_label is not None:
        if container_label != identity:
            raise RuntimeError("Disposable Admin container ownership changed.")
        stopped = docker("stop", container)
        if stopped.returncode and inspect_optional("container", container, "{{.Id}}") is not None:
            raise RuntimeError("Disposable Admin container did not stop.")
        for _ in range(30):
            if inspect_optional("container", container, "{{.Id}}") is None:
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("Disposable Admin container did not stop.")
    volume_label = inspect_optional("volume", volume, '{{index .Labels "shimpz.perf.run"}}')
    if volume_label is not None:
        if volume_label != identity:
            raise RuntimeError("Disposable Admin volume ownership changed.")
        required_docker("volume", "rm", volume)
    absent = {
        "container_absent": inspect_optional("container", container, "{{.Id}}") is None,
        "volume_absent": inspect_optional("volume", volume, "{{.Name}}") is None,
    }
    print(json.dumps({"type": "owned_cleanup", **absent}))
    if not all(absent.values()):
        raise RuntimeError("Disposable Admin residue remains.")


def benchmark_command(container: str, browser_image_id: str) -> list[str]:
    options = [
        "run",
        "--rm",
        "--pull=never",
        "--network",
        f"container:{container}",
        "--shm-size",
        "1g",
        "--cpus",
        str(BROWSER_CPUS),
        "--memory",
        f"{BROWSER_MEMORY_MIB}m",
        "--user",
        "1000:1000",
        "--volume",
        f"{FRONTEND}:/work:ro",
        "--workdir",
        "/work",
        "--env",
        "SHIMPZ_PERF_ISOLATED_AUTH=1",
    ]
    for name, default in (
        ("SHIMPZ_PERF_SAMPLES", "15"),
        ("SHIMPZ_PERF_COUNTS", "1,24"),
        ("SHIMPZ_PERF_API_DELAY_MS", "40"),
        ("SHIMPZ_PERF_SNAPSHOT_DELAY_MS", "40"),
        ("SHIMPZ_PERF_ICON_DELAY_MS", "80"),
        ("SHIMPZ_PERF_COMPOSITION", "balanced"),
    ):
        options += ["--env", f"{name}={os.environ.get(name, default)}"]
    return [*options, browser_image_id, "node", "perf/assistant-catalog.mjs"]


def image_metadata(image: str) -> dict[str, str | None]:
    image_id = required_docker("image", "inspect", image, "--format", "{{.Id}}").stdout.strip()
    labels = json.loads(required_docker("image", "inspect", image, "--format", "{{json .Config.Labels}}").stdout)
    return {
        "tag": image,
        "id": image_id,
        "source_revision_label": (labels or {}).get("org.opencontainers.image.revision"),
    }


def runtime_environment(admin_image: dict[str, str | None], browser_image: dict[str, str | None]) -> dict[str, object]:
    node = required_docker(
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--cpus",
        str(BROWSER_CPUS),
        "--memory",
        f"{BROWSER_MEMORY_MIB}m",
        browser_image["id"],
        "node",
        "-p",
        "process.version",
    ).stdout.strip()
    if node.split(".", 1)[0] != "v24":
        raise RuntimeError("The browser image must run Node.js 24.")
    checkout = FRONTEND.parent
    head = subprocess.run(
        ["git", "-C", str(checkout), "rev-parse", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()
    dirty = (
        subprocess.run(
            ["git", "-C", str(checkout), "status", "--porcelain"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        != ""
    )
    return {
        "type": "environment",
        "adminImage": admin_image,
        "browserImage": browser_image,
        "adminCheckoutHead": head,
        "adminCheckoutDirty": dirty,
        "node": node,
        "docker": required_docker("version", "--format", "{{.Server.Version}}").stdout.strip(),
        "hostProcessors": os.cpu_count(),
        "hostMemoryBytes": os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"),
        "adminCpus": ADMIN_CPUS,
        "adminMemoryMiB": ADMIN_MEMORY_MIB,
        "adminCpuset": os.environ.get("SHIMPZ_PERF_ADMIN_CPUSET"),
        "browserCpus": BROWSER_CPUS,
        "browserMemoryMiB": BROWSER_MEMORY_MIB,
    }


def run() -> None:
    admin_image = image_metadata(ADMIN_IMAGE)
    browser_image = image_metadata(BROWSER_IMAGE)
    print(json.dumps(runtime_environment(admin_image, browser_image)))
    identity = uuid.uuid4().hex[:12]
    container = f"shimpz-perf-admin-auth-{identity}"
    volume = f"shimpz-perf-admin-data-{identity}"
    require_unused("container", container)
    require_unused("volume", volume)
    try:
        required_docker("volume", "create", "--label", f"shimpz.perf.run={identity}", volume)
        admin_options = [
            "run",
            "--detach",
            "--rm",
            "--pull=never",
            "--name",
            container,
            "--label",
            f"shimpz.perf.run={identity}",
            "--network",
            "none",
            "--cpus",
            str(ADMIN_CPUS),
            "--memory",
            f"{ADMIN_MEMORY_MIB}m",
            "--memory-swap",
            f"{ADMIN_MEMORY_MIB}m",
            "--pids-limit",
            "128",
            "--user",
            "1000:1000",
            "--group-add",
            "10021",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--tmpfs",
            f"{CONTAINER_TEMP_DIR}:rw,noexec,nosuid,nodev,size=32m",
            "--tmpfs",
            "/run/shimpz-local-supervisor:rw,nosuid,nodev,noexec,size=1m,mode=2770,uid=0,gid=10021",
            "--volume",
            f"{volume}:/data",
            "--env",
            "SHIMPZ_ADMIN_PROFILE=local",
        ]
        cpuset = os.environ.get("SHIMPZ_PERF_ADMIN_CPUSET")
        if cpuset:
            admin_options += ["--cpuset-cpus", cpuset]
        required_docker(
            *admin_options,
            admin_image["id"],
            "uvicorn",
            "app:app",
            "--host",
            "127.0.0.1",
            "--port",
            "7777",
            "--workers",
            "1",
            "--log-level",
            "warning",
        )
        measured = docker(*benchmark_command(container, browser_image["id"]), timeout=300)
        if measured.returncode:
            raise RuntimeError("Isolated Admin benchmark failed; no credential-bearing trace was saved.")
        print(measured.stdout, end="")
    finally:
        owned_cleanup(container, volume, identity)


if __name__ == "__main__":
    run()
