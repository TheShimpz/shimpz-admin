"""The Supervisor's authorization of one Assistant Integration challenge, as session calls (ADR-0114).

The page opens its popup on the person's own gesture and then asks for the authorization over its session socket. The
callback mode follows the Origin the socket is bound to, exactly as it followed the request's Origin: the loopback and
Local-domain origins return through Admin's own OAuth start route, and a learned HTTPS origin completes out of band
with a code the person pastes back. Each handoff is bound to the socket's Supervisor session.
"""

from collections.abc import Callable
from urllib.parse import urlencode

import request_body
import state
from fastapi import HTTPException
from team import transport

from chat import payloads
from integrations import assistants as integrations
from integrations import handoff as handoff_store

OAUTH_ORIGINS = {
    "loopback": "http://127.0.0.1:7777",
    "local-domain": "https://local.shimpz.com",
}
OAUTH_START_PATH = "/api/oauth/cloudflare/start"
HANDOFFS = handoff_store.OAuthHandoffStore()


def callback_mode(origin: str | None, allowed_origins: Callable[[], frozenset[str]]) -> str:
    """The OAuth callback mode Admin's own page at `origin` completes an authorization with."""
    if origin is None or origin not in allowed_origins():
        raise HTTPException(status_code=403, detail="OAuth authorization origin is not admitted")
    if origin == OAUTH_ORIGINS["loopback"]:
        return "loopback"
    if origin == OAUTH_ORIGINS["local-domain"]:
        return "local-domain"
    if origin.startswith("https://") and origin == state.browser_origin():
        return "out-of-band"
    raise HTTPException(status_code=409, detail="OAuth authorization is unavailable for this Admin address")


def _refused(exc: Exception, status: int) -> HTTPException:
    return HTTPException(status_code=status, detail=str(exc))


def _started(mode: str, preparation: handoff_store.OAuthPreparation, result: transport.TeamResponse) -> dict[str, str]:
    if mode == "out-of-band":
        return {"authorization_url": result.body["authorization_url"], "completion_mode": "code"}
    url = OAUTH_ORIGINS[mode] + OAUTH_START_PATH + "?" + urlencode({"handoff": preparation.token})
    return {"authorization_url": url, "completion_mode": "automatic"}


def authorize(
    team_id: str, challenge_id: str, payload: dict, session: str, origin: str, allowed: Callable[[], frozenset[str]]
) -> object:
    """Start one challenge's authorization with Team and publish its handoff only after Team answered with a URL.

    `origin` is the Admin page's own Origin, which `allowed` must still admit, and it chooses the callback mode.
    """
    request_body.exact_fields(payload, "assistant_id", "integration_id")
    mode = callback_mode(origin, allowed)
    preparation = None
    authorized = False
    try:
        canonical_team = payloads.canonical_team_id(team_id)
        canonical_challenge = payloads.canonical_challenge_id(challenge_id)
        preparation = HANDOFFS.issue(
            team_id=canonical_team, challenge_id=canonical_challenge, admin_session=session, callback_mode=mode
        )
        result = integrations.start_local_assistant_integration_authorization(
            canonical_team,
            canonical_challenge,
            payload["assistant_id"],
            payload["integration_id"],
            preparation.session_binding,
            mode,
        )
        if result.status != 200:
            return result
        HANDOFFS.authorize(preparation.token, result.body.get("authorization_url"))
        authorized = True
    except transport.TeamRequestError as exc:
        raise _refused(exc, 400) from None
    except handoff_store.OAuthHandoffError as exc:
        raise _refused(exc, 409) from None
    finally:
        if preparation is not None and not authorized:
            HANDOFFS.discard(preparation.token)
    return _started(mode, preparation, result)


def complete(team_id: str, challenge_id: str, payload: dict, session: str) -> transport.TeamResponse:
    """Finish an out-of-band authorization with the completion code the person pasted back."""
    request_body.exact_fields(payload, "completion_code")
    try:
        completion = HANDOFFS.complete(
            team_id=payloads.canonical_team_id(team_id),
            challenge_id=payloads.canonical_challenge_id(challenge_id),
            admin_session=session,
            completion_code=payload["completion_code"],
        )
        return integrations.complete_cloudflare_oauth_callback(
            state=completion.state, claim=completion.claim, session_binding=completion.session_binding
        )
    except transport.TeamRequestError as exc:
        raise _refused(exc, 400) from None
    except handoff_store.OAuthHandoffError as exc:
        raise _refused(exc, 409) from None


def cancel(team_id: str, challenge_id: str, session: str) -> object:
    """Cancel the session's pending authorization of one challenge; nothing pending is already cancelled (204)."""
    try:
        canonical_team = payloads.canonical_team_id(team_id)
        canonical_challenge = payloads.canonical_challenge_id(challenge_id)
        binding = HANDOFFS.cancel(team_id=canonical_team, challenge_id=canonical_challenge, admin_session=session)
        if binding is None:
            return 204, {}
        result = integrations.cancel_local_assistant_integration_authorization(
            canonical_team, canonical_challenge, binding
        )
    except transport.TeamRequestError as exc:
        raise _refused(exc, 400) from None
    except handoff_store.OAuthHandoffError as exc:
        raise _refused(exc, 409) from None
    return (204, {}) if result.status == 204 else result
