"""Every Admin operation a session socket call names (ADR-0114 decision 3), each the backend function its route ran.

A method answers exactly as its HTTP route did: the same validation, Team identity checks, limits, executors, and audit.
Every operation that reads or changes Team state runs on a lane worker that checks the socket's Origin and session
again when its turn comes. A Team deletion confirms the Supervisor password first, within sign-in's own limiter and
lockout and journaled with the socket's bound Origin, exactly as its route did with the request's. A Team's Routines
are `session.routines`, and the Supervisor's two-step operations `session.stepup`.
"""

import sys
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

import decision
import models
import request_body
from fastapi import HTTPException
from history import http as history_http
from protocol.socket.v1 import frames
from session import lane, routines, stepup, topics, watcher
from signin import security
from space import release as platform_release
from team import bridge as team
from team import http as team_http
from team import inference as team_inference
from team import names as team_names
from team import order as team_order
from team import snapshots as team_snapshots
from team import summary as team_summary
from team import transport

from action import stored_input
from chat import assets as chat_assets
from integrations import assistants as integrations
from integrations import authorization

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

    def handler(*args: object) -> transport.TeamResponse:
        with team_http.refused_as_bad_request():
            return getattr(owner, operation)(*args)

    async def method(socket: SessionSocket, params: dict[str, object]) -> Answer:
        return await lane.run(socket, handler, *(params.get(name) for name in names))

    return method


def _saved_key(configure: Callable[..., dict[str, object]], *args: object) -> dict[str, object]:
    """Validate a key with its provider, then store it; a rejected key is 400 and an unreachable provider 503."""
    try:
        return configure(*args)
    except models.ModelProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except models.ModelProviderUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


def save_model_key(provider: str, payload: dict) -> dict[str, object]:
    request_body.exact_fields(payload, "api_key")
    return _saved_key(models.configure, provider, payload["api_key"])


def save_decision_key(payload: dict) -> dict[str, object]:
    """Save the Supervisor's TypeSafe key for the intent-classification fast path (ADR-0077)."""
    request_body.exact_fields(payload, "api_key")
    return _saved_key(decision.configure, payload["api_key"])


# The Space's and the session's state


def _session(socket: SessionSocket) -> str:
    return socket.cookies.get(socket.gate.cookie, "")


def security_summary(session: str) -> dict[str, object]:
    """The session's sign-in security summary; a session that ended meanwhile is signed out."""
    try:
        return security.summary_for(session)
    except security.SessionEndedError:
        raise HTTPException(status_code=401, detail="unauthenticated") from None


def acknowledge_failures(session: str, payload: dict) -> dict[str, object]:
    """Acknowledge exactly the refused attempts the Supervisor saw, answering the summary after it."""
    count = security.acknowledged_count(payload)
    if count is None:
        raise HTTPException(status_code=400, detail="request body must contain only a positive acknowledged count")
    try:
        summary = security.acknowledge(session, count)
    except security.SessionEndedError:
        raise HTTPException(status_code=401, detail="unauthenticated") from None
    topics.changed("security/summary")
    return summary


async def _security(socket: SessionSocket, _params: dict[str, object]) -> Answer:
    return await lane.run(socket, security_summary, _session(socket))


async def _acknowledge(socket: SessionSocket, params: dict[str, object]) -> Answer:
    return await lane.run(socket, acknowledge_failures, _session(socket), params["body"])


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


async def _install(
    socket: SessionSocket, call_id: str, install: Callable[..., transport.TeamResponse], params
) -> Answer:
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
    "platform.release": _on_lane(platform_release, "status_response"),
    "security.summary": _security,
    "security.acknowledge": _acknowledge,
    "recovery_codes.confirmation": stepup.recovery_codes_confirmation,
    "recovery_codes.replace": stepup.recovery_codes_replace,
    "supervisor_key.confirmation": stepup.supervisor_key_confirmation,
    "supervisor_key.rotate": stepup.supervisor_key_rotate,
    "inference.read": _on_lane(team_inference, "status", "team_id"),
    "inference.save": _on_lane(team_inference, "configure", "team_id", "body"),
    "assistants.registry": _on_lane(team_summary, "assistants_list"),
    "assistants.list": _team_call(team, "list_installed_assistants", "team_id"),
    "assistants.uninstall": _team_call(team, "uninstall_assistant", "team_id", "assistant_id"),
    "assistants.summary": _on_lane(team_summary, "assistant_summary", "team_id", "assistant_id", "locale"),
    "assistants.details": _on_lane(team_summary, "assistant_details", "team_id", "assistant_id", "locale"),
    "snapshots.list": _on_lane(team_snapshots, "local_assistants_list"),
    "snapshots.summary": _on_lane(team_snapshots, "local_assistant_summary", "image_id", "locale"),
    "snapshots.details": _on_lane(team_snapshots, "local_assistant_details", "image_id", "locale"),
    "models.list": _on_lane(models, "status"),
    "models.save": _on_lane(sys.modules[__name__], "save_model_key", "provider", "body"),
    "decision.read": _on_lane(decision, "status"),
    "decision.save": _on_lane(sys.modules[__name__], "save_decision_key", "body"),
    "decision.remove": _on_lane(decision, "remove"),
    "integrations.list": _team_call(integrations, "list_assistant_integrations", "team_id"),
    "integrations.authorize": _authorize,
    "integrations.complete": _complete,
    "integrations.cancel": _cancel,
    "stored_inputs.list": _team_call(stored_input, "list_assistant_stored_inputs", "team_id"),
    "stored_inputs.clear": _team_call(
        stored_input, "clear_assistant_stored_input", "team_id", "assistant_id", "stored_input_id"
    ),
    "store.catalog": _catalog,
    "subscribe": _subscribe,
    "unsubscribe": _unsubscribe,
    "chat.attach": _attach,
    "chat.detach": _detach,
    **routines.METHODS,
}


def _installer(operation: str) -> Callable[[SessionSocket, str, dict[str, object]], Awaitable[Answer]]:
    async def method(socket: SessionSocket, call_id: str, params: dict[str, object]) -> Answer:
        return await _install(socket, call_id, getattr(team, operation), params)

    return method


# Long calls also take the call's own id, so they can tell the page when they start.
LONG_METHODS = {
    "assistants.install": _installer("install_assistant"),
    "assistants.install_local": _installer("install_local_assistant"),
    **routines.LONG_METHODS,
}


async def dispatch(socket: SessionSocket, call_id: str, method: str, params: dict[str, object]) -> Answer:
    if method in LONG_METHODS:
        return await LONG_METHODS[method](socket, call_id, params)
    return await METHODS[method](socket, params)
