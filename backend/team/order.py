"""Local Team list order: the Supervisor's saved arrangement over Team's newest-first inventory.

`team-order.json` is Admin-owned presentation state beside, never inside, `admin.json`: exactly `{"team_ids"}` with
at most 128 unique canonical Team ids in a private regular file. A Team the saved order does not name leads, newest
first as Team lists it; the saved ids that still name a Team follow in saved order. A read never rewrites the file.
A missing file is the newest-first order, and a file that cannot be read or validated falls back to it with a
sanitized diagnostic; a failed Supervisor, inventory, or ownership check is never bypassed.

One lock serializes a reorder with Admin's Team creation, deletion, and Space reset, so a saved position never
outlives its Team into a later Team that reuses the id. Only the Local profile registers these.
"""

from __future__ import annotations

import json
import logging
import os
import stat
import tempfile
import threading
from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from team import bridge
from team import http as team_http

from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import strict_json

ORDER_PATH = Path(os.environ.get("SHIMPZ_TEAM_ORDER_STORE") or "/data/team-order.json")
MAX_ORDER_BYTES = 8 * 1024
MAX_ORDER_BODY_BYTES = 8 * 1024
LOCK = threading.Lock()
log = logging.getLogger("shimpz-admin")


class OrderUnavailableError(RuntimeError):
    """The saved Team order cannot be read or committed safely."""


class OrderInvalidError(OrderUnavailableError):
    """The saved Team order exists but is not a valid private order, so it names no Team."""


def canonical_ids(value: object) -> list[str] | None:
    """At most 128 unique canonical Team ids, exactly as sent."""
    if (
        not isinstance(value, list)
        or len(value) > bridge.MAX_TEAMS
        or not all(isinstance(item, str) and team_contract.canonical_team_id(item) == item for item in value)
        or len(set(value)) != len(value)
    ):
        return None
    return value


def load() -> list[str] | None:
    """The saved order, or None when none is saved."""
    try:
        # No link is followed and a special file never blocks the read.
        descriptor = os.open(ORDER_PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise OrderUnavailableError("Team order cannot be opened") from exc
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
            or metadata.st_uid != os.geteuid()
        ):
            raise OrderInvalidError("Team order is not a private regular file")
        raw = os.read(descriptor, MAX_ORDER_BYTES + 1)
    except OSError as exc:
        raise OrderUnavailableError("Team order cannot be read") from exc
    finally:
        os.close(descriptor)
    if len(raw) != metadata.st_size or len(raw) > MAX_ORDER_BYTES:
        raise OrderInvalidError("Team order has an invalid size")
    try:
        value = strict_json.loads(raw)
    except ValueError, RecursionError:
        raise OrderInvalidError("Team order is not JSON") from None
    if (
        not isinstance(value, dict)
        or set(value) != {"team_ids"}
        or (team_ids := canonical_ids(value["team_ids"])) is None
    ):
        raise OrderInvalidError("Team order is invalid")
    return team_ids


def _sync_parent() -> None:
    """Complete the directory durability barrier, so an earlier rename or unlink is on disk before it is relied on.

    It runs even when a retry finds nothing left to change: an earlier attempt may have renamed or unlinked before
    its own barrier failed. A missing directory holds no order, so it has nothing to make durable.
    """
    try:
        directory = os.open(ORDER_PATH.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    except FileNotFoundError:
        return
    except OSError as exc:
        raise OrderUnavailableError("Team order directory cannot be opened") from exc
    try:
        os.fsync(directory)
    except OSError as exc:
        raise OrderUnavailableError("Team order directory cannot be synchronized") from exc
    finally:
        os.close(directory)


def _save(team_ids: list[str]) -> None:
    """Atomically and durably replace the order: a 0600 temporary file is fsynced, renamed, then its directory."""
    payload = json.dumps({"team_ids": team_ids}, separators=(",", ":")).encode("ascii")
    try:
        descriptor, name = tempfile.mkstemp(prefix=f".{ORDER_PATH.name}.", suffix=".tmp", dir=ORDER_PATH.parent)
    except OSError as exc:
        raise OrderUnavailableError("Team order cannot be written") from exc
    temporary = Path(name)
    try:
        try:
            # os.write may write fewer bytes than asked; only a complete payload may replace the order.
            view = memoryview(payload)
            while view:
                view = view[os.write(descriptor, view) :]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        temporary.replace(ORDER_PATH)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise OrderUnavailableError("Team order cannot be written") from exc
    _sync_parent()


def _unlink_owned(path: Path) -> None:
    """Remove one cleanup entry only when it is this Admin's own regular file; anything else stays and refuses."""
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    except OSError as exc:
        raise OrderUnavailableError("Team order cannot be inspected") from exc
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid():
        raise OrderUnavailableError("Team order entry is not Admin's own file")
    try:
        path.unlink()
    except OSError as exc:
        raise OrderUnavailableError("Team order cannot be removed") from exc


def _saved_for_mutation() -> list[str] | None:
    """The saved order a lifecycle mutation edits; an invalid one is removed, never read as naming no Team.

    Listing alone falls back to newest first past an invalid order. A mutation removes Admin's own invalid file, so
    no position it held can return once its metadata is repaired, and refuses when it cannot remove it.
    """
    try:
        return load()
    except OrderInvalidError:
        log.warning("Admin Team order is invalid; removing it")
        _unlink_owned(ORDER_PATH)
        return None


def forget(team_id: str) -> None:
    """Durably remove one Team's saved position."""
    saved = _saved_for_mutation()
    if saved is not None and team_id in saved:
        _save([item for item in saved if item != team_id])
    else:
        _sync_parent()


def clear() -> None:
    """Durably remove the saved order and any temporary file an interrupted write left.

    Only Admin's own regular files are removed. A foreign, special, or linked entry stays in place, and the reset
    reports its cleanup incomplete after the removals it could make are durable.
    """
    unsafe = False
    for path in (ORDER_PATH, *ORDER_PATH.parent.glob(f".{ORDER_PATH.name}.*.tmp")):
        try:
            _unlink_owned(path)
        except OrderUnavailableError:
            unsafe = True
    _sync_parent()
    if unsafe:
        raise OrderUnavailableError("Team order cleanup left an entry that is not Admin's own file")


def arrange(teams: list[dict[str, str]], saved: list[str] | None) -> list[dict[str, str]]:
    """Unsaved Teams first in Team's newest-first order, then the surviving saved ids in saved order."""
    by_id = {team["team_id"]: team for team in teams}
    pinned = set(saved or ())
    return [team for team in teams if team["team_id"] not in pinned] + [
        by_id[team_id] for team_id in saved or () if team_id in by_id
    ]


def _unavailable(detail: str) -> bridge.TeamResponse:
    return bridge.TeamResponse(503, {"code": "team-order-unavailable", "detail": detail})


def _fresh_inventory() -> bridge.TeamResponse | list[dict[str, str]]:
    """Team's authoritative inventory, read now; an unavailable or invalid one is never replaced by a guess."""
    inventory = bridge.team_inventory(bridge.list_teams())
    if isinstance(inventory, bridge.TeamResponse) and inventory.status >= 500:
        return bridge.TeamResponse(
            503, {"code": "team-inventory-unavailable", "detail": "The Team list is unavailable; try again"}
        )
    return inventory


def _listing() -> bridge.TeamResponse:
    """The Team list in the Supervisor's order."""
    response = bridge.list_teams()
    teams = bridge.team_inventory(response)
    if isinstance(teams, bridge.TeamResponse):
        return teams
    try:
        saved = load()
    except OrderUnavailableError as exc:
        log.warning("Admin Team order is unavailable (%s); listing Teams newest first", type(exc).__name__)
        saved = None
    return bridge.TeamResponse(response.status, {**response.body, "teams": arrange(teams, saved)})


def reorder(team_ids: list[str]) -> bridge.TeamResponse:
    """Save an exact permutation of the current Teams as their list order."""
    with LOCK:
        teams = _fresh_inventory()
        if isinstance(teams, bridge.TeamResponse):
            return teams
        if set(team_ids) != {team["team_id"] for team in teams}:
            return bridge.TeamResponse(
                409, {"code": "team-order-stale", "detail": "The Team list changed; reload it and reorder again"}
            )
        try:
            _save(team_ids)
        except OrderUnavailableError:
            log.exception("Admin Team order could not be saved")
            return _unavailable("The Team order could not be saved; try again")
        return bridge.TeamResponse(200, {"teams": arrange(teams, team_ids)})


def release_for_create(team_id: str) -> bridge.TeamResponse | None:
    """Before Admin creates a Team id, durably drop a saved position the id kept from a Team that no longer exists.

    The caller holds LOCK across this release and its creation. A refusal is returned before anything is created.
    """
    try:
        saved = _saved_for_mutation()
        if saved is None or team_id not in saved:
            _sync_parent()
            return None
        teams = _fresh_inventory()
        if isinstance(teams, bridge.TeamResponse):
            return teams
        if all(team["team_id"] != team_id for team in teams):
            _save([item for item in saved if item != team_id])
    except OrderUnavailableError:
        log.exception("Admin Team order could not release a stale position before Team creation")
        return _unavailable("The Team order is unavailable, so no Team was created; try again")
    return None


def _cleanup(response: bridge.TeamResponse, action: Callable[[], None], detail: str) -> bridge.TeamResponse:
    if not 200 <= response.status < 300:
        return response
    try:
        action()
    except OrderUnavailableError:
        log.exception("Admin Team order cleanup is unavailable")
        return bridge.TeamResponse(503, {"code": "team-order-cleanup-incomplete", "detail": detail})
    return response


def team_deleted(team_id: str, response: bridge.TeamResponse) -> bridge.TeamResponse:
    """After a successful Team deletion, which the caller holds LOCK across, remove the Team's saved position."""
    return _cleanup(
        response,
        lambda: forget(team_id),
        "The Team was deleted, but Admin could not remove its saved list position; retry the deletion",
    )


def space_reset(response: bridge.TeamResponse) -> bridge.TeamResponse:
    """After a successful Space reset, which the caller holds LOCK across, remove the saved order."""
    return _cleanup(
        response,
        clear,
        "The Space was reset, but Admin could not remove the saved Team order; run the Space reset again",
    )


def _requested_ids(payload: dict) -> list[str]:
    if set(payload) != {"team_ids"}:
        raise HTTPException(status_code=400, detail="request body must contain only team_ids")
    team_ids = canonical_ids(payload["team_ids"])
    if team_ids is None:
        raise HTTPException(status_code=400, detail="team_ids must list at most 128 unique canonical Team ids")
    return team_ids


def listing() -> JSONResponse:
    """The Local Team list route's answer, which is never cached."""
    response = team_http.response(_listing)
    response.headers["Cache-Control"] = "no-store"
    return response


def register(app: FastAPI, allowed_origins: Callable[[], frozenset[str]]) -> None:
    async def save(request: Request) -> JSONResponse:
        team_http.require_admitted_origin(request, allowed_origins)
        team_ids = _requested_ids(await team_http.bounded_json_object(request, MAX_ORDER_BODY_BYTES))
        return await run_in_threadpool(team_http.response, lambda: reorder(team_ids))

    async def teams_reorder(request: Request) -> JSONResponse:
        """Save the Team list order; every answer, including a refusal, is no-store."""
        return await team_http.no_store(lambda: save(request))

    app.add_api_route("/api/teams/order", teams_reorder, methods=["PUT"])
