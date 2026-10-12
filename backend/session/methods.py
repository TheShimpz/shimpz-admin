"""Every Admin operation a session socket call names (ADR-0114 decision 3), each the backend function its route ran.

A method answers exactly as its HTTP route did: the same validation, Team identity checks, limits, executors, and audit.
Every operation that reads or changes Team state runs on a lane worker that checks the socket's Origin and session
again when its turn comes. A Team deletion confirms the Supervisor password first, within sign-in's own limiter and
lockout and journaled with the socket's bound Origin, exactly as its route did with the request's.
"""

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

import decision
import models
from fastapi import HTTPException
from history import http as history_http
from protocol.socket.v1 import frames
from session import lane, topics, watcher
from signin import security
from space import release as platform_release
from team import bridge as team
from team import files as team_files
from team import http as team_http
from team import inference as team_inference
from team import names as team_names
from team import order as team_order
from team import snapshots as team_snapshots
from team import summary as team_summary

from action import stored_input
from chat import assets as chat_assets
from integrations import assistants as integrations
from integrations import authorization
from routine import http as routine_http

if TYPE_CHECKING:
    from session.socket import SessionSocket

Answer = lane.Answer
Method = Callable[["SessionSocket", dict[str, object]], Awaitable[Answer]]


def _on_lane(owner: object, operation: str, *names: str) -> Method:
    """A method that runs `owner.operation`, found when it runs, with the named parameters in order on the lane."""

    async def method(socket: SessionSocket, params: dict[str, object]) -> Answer:
        return await lane.run(socket, getattr(owner, operation), *(params.get(name) for name in names))

    return method


def _team_call(owner: object, operation: str, *names: str) -> Method:
    """A method whose answer is Team's own, as its route passed it on: a request Admin refused before Team is 400."""

    def handler(*args: object) -> team.TeamResponse:
        with team_http.refused_as_bad_request():
            return getattr(owner, operation)(*args)

    async def method(socket: SessionSocket, params: dict[str, object]) -> Answer:
        return await lane.run(socket, handler, *(params.get(name) for name in names))

    return method


# The Space's and the session's state


def _session(socket: SessionSocket) -> str:
    return socket.cookies.get(socket.gate.cookie, "")


async def _resources(socket: SessionSocket, _params: dict[str, object]) -> Answer:
    return await lane.run(socket, team_http.response, team.space_resources)


async def _security(socket: SessionSocket, _params: dict[str, object]) -> Answer:
    return await lane.run(socket, security.summary_for, _session(socket))


# Teams


async def _team_delete(socket: SessionSocket, params: dict[str, object]) -> Answer:
    """Delete one Team after the exact current name and the Supervisor password confirm it."""
    try:
        team_name, password = team_names.deletion(params["body"])
        await socket.gate.recheck_password(socket.origin, password)
    except HTTPException as exc:
        return exc.status_code, {"detail": exc.detail}
    return await lane.run(socket, team_names.delete, params["team_id"], team_name)


# Assistants


async def _install(socket: SessionSocket, call_id: str, install: Callable[..., team.TeamResponse], params) -> Answer:
    """An install runs on its own lane; once it starts, the page hears so, and its result follows when Team answers."""

    def started() -> None:
        socket.loop.call_soon_threadsafe(socket.progress, call_id)

    return await lane.run(
        socket,
        team_http.response,
        lambda: install(params["team_id"], params["body"]),
        executor=lane.INSTALL_LANE,
        started=started,
    )


# Integrations


async def _authorize(socket: SessionSocket, params: dict[str, object]) -> Answer:
    """The callback mode follows the Origin the socket is bound to, as the route's followed the request's Origin."""
    args = (params["team_id"], params["challenge_id"], params["body"], _session(socket), socket.origin)
    return await lane.run(socket, authorization.authorize, *args, socket.gate.allowed_origins)


async def _complete(socket: SessionSocket, params: dict[str, object]) -> Answer:
    args = (params["team_id"], params["challenge_id"], params["body"], _session(socket))
    return await lane.run(socket, authorization.complete, *args)


async def _cancel(socket: SessionSocket, params: dict[str, object]) -> Answer:
    return await lane.run(socket, authorization.cancel, params["team_id"], params["challenge_id"], _session(socket))


# The public Store catalog


async def _catalog(socket: SessionSocket, params: dict[str, object]) -> Answer:
    """One catalog page, on the catalog's own single-worker executor, which answers 503 when busy as it always did."""
    return await lane.run(
        socket,
        chat_assets.catalog_page,
        params["locale"],
        params.get("cursor"),
        executor=chat_assets.CATALOG_EXECUTOR,
        full=chat_assets.CATALOG_FULL,
    )


# What the socket holds


async def _subscribe(socket: SessionSocket, params: dict[str, object]) -> Answer:
    named = frames.topics(params)
    if len(socket.subscriptions | set(named)) > frames.MAX_SUBSCRIPTIONS:
        return 409, {"detail": "a session socket subscribes to at most 64 topics"}
    socket.subscriptions.update(named)
    watcher.WATCHER.refresh()
    return 200, _subscription(socket)


async def _unsubscribe(socket: SessionSocket, params: dict[str, object]) -> Answer:
    socket.subscriptions.difference_update(frames.topics(params))
    watcher.WATCHER.refresh()
    return 200, _subscription(socket)


def _subscription(socket: SessionSocket) -> dict[str, object]:
    """The socket's topics and each one's current revision in this epoch."""
    return {
        "epoch": topics.EPOCH,
        "topics": {topic: topics.revision(topic) for topic in sorted(socket.subscriptions)},
    }


async def _attach(socket: SessionSocket, params: dict[str, object]) -> Answer:
    return socket.attach(params["team_id"], params["locale"])


async def _detach(socket: SessionSocket, params: dict[str, object]) -> Answer:
    return socket.detach(params["team_id"])


METHODS: dict[str, Method] = {
    "teams.list": _on_lane(team_order, "listing"),
    "teams.create": _on_lane(team_names, "create", "body"),
    "teams.rename": _on_lane(team_names, "rename", "team_id", "body"),
    "teams.reorder": _on_lane(team_order, "save", "body"),
    "teams.delete": _team_delete,
    "history.page": _on_lane(history_http, "page", "team_id", "before", "routine"),
    "routines.list": _on_lane(routine_http, "routines_list", "team_id"),
    "space.resources": _resources,
    "platform.release": _on_lane(platform_release, "status_response"),
    "security.summary": _security,
    "inference.read": _on_lane(team_inference, "status", "team_id"),
    "inference.save": _on_lane(team_inference, "configure", "team_id", "body"),
    "action_confirmation.read": _on_lane(team_inference, "action_confirmation_status", "team_id"),
    "action_confirmation.save": _on_lane(team_inference, "action_confirmation_configure", "team_id", "body"),
    "assistants.registry": _on_lane(team_summary, "assistants_list"),
    "assistants.list": _team_call(team, "list_installed_assistants", "team_id"),
    "assistants.uninstall": _team_call(team, "uninstall_assistant", "team_id", "assistant_id"),
    "assistants.summary": _on_lane(team_summary, "assistant_summary", "team_id", "assistant_id", "locale"),
    "assistants.details": _on_lane(team_summary, "assistant_details", "team_id", "assistant_id", "locale"),
    "snapshots.list": _on_lane(team_snapshots, "local_assistants_list"),
    "snapshots.summary": _on_lane(team_snapshots, "local_assistant_summary", "image_id", "locale"),
    "snapshots.details": _on_lane(team_snapshots, "local_assistant_details", "image_id", "locale"),
    "models.list": _on_lane(models, "status"),
    "models.save": _on_lane(models, "save", "provider", "body"),
    "models.remove": _on_lane(models, "delete", "provider"),
    "decision.read": _on_lane(decision, "status"),
    "decision.save": _on_lane(decision, "save", "body"),
    "decision.remove": _on_lane(decision, "remove"),
    "integrations.list": _team_call(integrations, "list_assistant_integrations", "team_id"),
    "integrations.authorize": _authorize,
    "integrations.complete": _complete,
    "integrations.cancel": _cancel,
    "integrations.disconnect": _team_call(
        integrations, "disconnect_assistant_integration", "team_id", "assistant_id", "integration_id"
    ),
    "stored_inputs.list": _team_call(stored_input, "list_assistant_stored_inputs", "team_id"),
    "stored_inputs.clear": _team_call(
        stored_input, "clear_assistant_stored_input", "team_id", "assistant_id", "stored_input_id"
    ),
    "files.list": _on_lane(team_files, "team_files_list", "team_id"),
    "files.delete": _on_lane(team_files, "team_file_delete", "team_id", "file_id"),
    "store.catalog": _catalog,
    "subscribe": _subscribe,
    "unsubscribe": _unsubscribe,
    "chat.attach": _attach,
    "chat.detach": _detach,
}
# Long calls also take the call's own id, so they can tell the page when they start.
LONG_METHODS = {"assistants.install": "install_assistant", "assistants.install_local": "install_local_assistant"}


async def dispatch(socket: SessionSocket, call_id: str, method: str, params: dict[str, object]) -> Answer:
    if method in LONG_METHODS:
        return await _install(socket, call_id, getattr(team, LONG_METHODS[method]), params)
    return await METHODS[method](socket, params)
