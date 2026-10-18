"""Bounded Admin -> team bridge for Teams and trusted Assistants.

The local Admin owns the signed browser session but never receives Docker access.  The
team owns runtime lifecycle and admission; this module reaches only its fixed internal
HTTP routes with the existing bearer file.  Team JSON and HTTP status codes are preserved so a
safe 400/404/409 is not flattened into an ambiguous gateway error.
"""

import logging
import re
import unicodedata
from collections.abc import Callable

import models
from session import topics
from team import transport

from chat import payloads
from protocol.http.v1 import browser_view as view_contract
from protocol.http.v1 import payload as team_contract
from protocol.http.v1 import preview as preview_contract
from protocol.http.v1 import turn as team_turn

log = logging.getLogger("shimpz-admin")

MAX_CHAT_JSON_BODY_BYTES = 128 * 1024
# A chat turn's stream is silent while Team waits on one Brain request, which Team allows 300 s
# (teams/inference/client.py RESPONSE_TIMEOUT_SECONDS): Admin waits that long for its next record, and a little more,
# before it calls the turn lost.
CHAT_STREAM_TIMEOUT_SECONDS = 330
MAX_FILE_UPLOAD_BYTES = team_contract.MAX_FILE_UPLOAD_BYTES
CAPABILITY_PLAN_TIMEOUT_SECONDS = 65
INTENT_ROUTE_TIMEOUT_SECONDS = 25
ASSISTANT_INSTALL_TIMEOUT_SECONDS = 360

MAX_TEAMS = 128
_LATIN_ASCII_EXPANSIONS = str.maketrans(
    {"æ": "ae", "đ": "d", "ð": "d", "ı": "i", "ł": "l", "ø": "o", "œ": "oe", "þ": "th"}
)


def to_team_id(team_name: object) -> str:
    """A Team name -> the Docker/Postgres-safe id used by team."""
    folded = unicodedata.normalize("NFKD", str(team_name).casefold().translate(_LATIN_ASCII_EXPANSIONS))
    ascii_name = folded.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9_]+", "_", ascii_name).strip("_")[:40]


def canonical_team_name(value: object) -> str:
    canonical = team_contract.canonical_team_name(value)
    if canonical is None:
        raise transport.TeamRequestError("team name must contain 1 to 80 trimmed characters")
    return canonical


def canonical_local_team_name(value: object) -> str:
    """A Local Team display name exactly as Team admits it: trimmed, bounded, and NFC (ADR-0088)."""
    canonical = team_contract.canonical_local_team_name(value)
    if canonical is None:
        raise transport.TeamRequestError("team name must contain 1 to 80 trimmed characters")
    return canonical


def canonical_source_digest(value: object) -> str:
    if not isinstance(value, str) or team_contract.SOURCE_DIGEST_RE.fullmatch(value) is None:
        raise transport.TeamRequestError("source digest must be a canonical sha256 digest")
    return value


def canonical_filename(value: object) -> str:
    canonical = team_contract.canonical_filename(value)
    if canonical is None:
        raise transport.TeamRequestError("filename must be a trimmed, non-path UTF-8 name")
    return canonical


def canonical_media_type(value: object) -> str:
    media_type = team_contract.canonical_media_type(value)
    if media_type is None:
        raise transport.TeamRequestError("invalid media type")
    return media_type


def list_teams() -> transport.TeamResponse:
    return transport.call("GET", "/v1/teams")


def reset_space() -> transport.TeamResponse:
    response = transport.call("DELETE", "/v1/space")
    # Admin owns the bounded Supervisor success contract; Team owns operation failure semantics.
    if not 200 <= response.status < 300:
        return response
    if not isinstance(response.body, dict) or response.body.get("reset") is not True:
        # This gateway response is Admin-authored and never relays the malformed Team payload.
        log.warning("team returned an invalid Space reset response")
        return transport.TeamResponse(502, {"detail": "Team returned an invalid Space reset response"})
    return transport.TeamResponse(200, {"reset": True})


def bootstrap_reset_space() -> transport.TeamResponse:
    response = transport.call("DELETE", "/v1/space/bootstrap")
    if response.status == 409:
        log.warning("Team refused bootstrap reset because Supervisor state already exists")
        return transport.TeamResponse(
            409,
            {
                "code": "bootstrap-reset-refused",
                "detail": "Supervisor identity exists but Admin is not initialized; nothing was deleted",
            },
        )
    if not 200 <= response.status < 300:
        log.warning("Team bootstrap reset is unavailable")
        status = 503 if response.status == 503 else 502
        return transport.TeamResponse(
            status,
            {
                "code": "bootstrap-reset-unavailable",
                "detail": "The bootstrap Space reset did not complete; re-run shimpz reset",
            },
        )
    if not isinstance(response.body, dict) or response.body.get("reset") is not True:
        log.warning("Team returned an invalid bootstrap reset response")
        return transport.TeamResponse(
            502,
            {
                "code": "bootstrap-reset-unavailable",
                "detail": "The bootstrap Space reset did not complete; re-run shimpz reset",
            },
        )
    return transport.TeamResponse(200, {"reset": True})


def create(team_id: object, team_name: object) -> transport.TeamResponse:
    """Create a Local Team under a display name exactly as Team admits it (ADR-0088)."""
    canonical_id = payloads.canonical_team_id(team_id)
    name = canonical_local_team_name(team_name)
    return transport.call("POST", f"/v1/teams/{canonical_id}/create", {"team_name": name})


def team_inventory(response: transport.TeamResponse) -> transport.TeamResponse | list[dict[str, str]]:
    """Project the strict Team inventory in Team's order, or the failure that stands in for it."""
    if not 200 <= response.status < 300:
        return response
    try:
        if set(response.body) != transport.trace_envelope(response.body, {"teams"}):
            raise ValueError("unexpected inventory fields")
        inventory = response.body["teams"]
        if not isinstance(inventory, list) or len(inventory) > MAX_TEAMS:
            raise ValueError("invalid inventory")
        teams: list[dict[str, str]] = []
        seen: set[str] = set()
        for item in inventory:
            if not isinstance(item, dict) or set(item) != {"team_id", "team_name", "status"}:
                raise ValueError("invalid Team fields")
            item_id = payloads.canonical_team_id(item["team_id"])
            item_name = canonical_team_name(item["team_name"])
            if item["team_id"] != item_id or item["team_name"] != item_name or item["status"] != "running":
                raise ValueError("non-canonical Team identity")
            if item_id in seen:
                raise ValueError("duplicate Team identity")
            seen.add(item_id)
            teams.append({"team_id": item_id, "team_name": item_name, "status": "running"})
    except KeyError, TypeError, ValueError, transport.TeamRequestError:
        log.warning("team returned an invalid Team inventory")
        return transport.TeamResponse(502, {"detail": "Team inventory response is invalid."})
    return teams


def _authoritative_team_name(response: transport.TeamResponse, team_id: str) -> transport.TeamResponse | str:
    """Project one strict Team identity from the controller inventory before destruction."""
    inventory = team_inventory(response)
    if isinstance(inventory, transport.TeamResponse):
        return inventory
    for team in inventory:
        if team["team_id"] == team_id:
            return team["team_name"]
    return transport.TeamResponse(404, {"detail": "Team not found"})


def resolve_team_name(team_id: object) -> transport.TeamResponse | str:
    """Resolve one current Team name from the strict controller inventory."""
    canonical_id = payloads.canonical_team_id(team_id)
    return _authoritative_team_name(list_teams(), canonical_id)


def destroy_confirmed(team_id: object, expected_team_name: object) -> transport.TeamResponse:
    """Delete a Local Team; Team confirms its current name before any side effect (ADR-0088)."""
    canonical_id = payloads.canonical_team_id(team_id)
    return transport.call(
        "DELETE", f"/v1/teams/{canonical_id}", {"team_name": canonical_local_team_name(expected_team_name)}
    )


def rename(team_id: object, team_name: object) -> transport.TeamResponse:
    """Rename a Local Team; only its display name changes, never its id (ADR-0088)."""
    canonical_id = payloads.canonical_team_id(team_id)
    name = canonical_local_team_name(team_name)
    response = transport.call("PATCH", f"/v1/teams/{canonical_id}", {"team_name": name})
    if not 200 <= response.status < 300:
        return response
    body = response.body
    if (
        set(body) - {"trace_id"} != {"team_id", "team_name"}
        or body["team_id"] != canonical_id
        or body["team_name"] != name
        or ("trace_id" in body and not transport.is_trace_id(body["trace_id"]))
    ):
        log.warning("team returned an invalid rename response")
        return transport.TeamResponse(502, {"detail": "Team rename response is invalid."})
    return transport.TeamResponse(response.status, {"team_id": canonical_id, "team_name": name})


def _project_inference_response(
    response: transport.TeamResponse,
    team_id: str,
    *,
    expected: tuple[str, str] | None = None,
) -> transport.TeamResponse:
    """Project the authenticated controller envelope into the smaller browser contract."""
    if not 200 <= response.status < 300:
        return response
    try:
        if set(response.body) != {"team_id", "provider", "model", "trace_id"}:
            raise ValueError("unexpected inference fields")
        response_team_id = response.body["team_id"]
        provider = response.body["provider"]
        model = response.body["model"]
        trace_id = response.body["trace_id"]
        selected_team_id = payloads.canonical_team_id(response_team_id)
        selected_provider = models.canonical_provider(provider)
        selected_model = models.canonical_model(selected_provider, model)
        if (
            response_team_id != selected_team_id
            or selected_team_id != team_id
            or provider != selected_provider
            or model != selected_model
            or not transport.is_trace_id(trace_id)
        ):
            raise ValueError("non-canonical inference metadata")
        if expected is not None and (selected_provider, selected_model) != expected:
            raise ValueError("mismatched inference metadata")
    except KeyError, TypeError, ValueError, transport.TeamRequestError, models.ModelProviderError:
        # Never reflect controller fields: an invalid response could contain credentials or internals.
        log.warning("team returned an invalid inference response")
        return transport.TeamResponse(502, {"detail": "Team inference response is invalid."})
    return transport.TeamResponse(
        response.status,
        {"team_id": team_id, "provider": selected_provider, "model": selected_model},
    )


def _changed(
    response: transport.TeamResponse, team_id: str, *names: str, registry: bool = False
) -> transport.TeamResponse:
    """A change Admin made through Team raises the topics it changed for the session sockets that show them."""
    if transport.is_team_response(response) and 200 <= response.status < 300:
        topics.team_changed(team_id, *names)
        if registry:
            topics.changed("assistants/registry")
    return response


def get_inference(team_id: object) -> transport.TeamResponse:
    """Read provider/model metadata only; the controller response must never contain a key."""
    canonical_id = payloads.canonical_team_id(team_id)
    response = transport.call("GET", f"/v1/teams/{canonical_id}/inference")
    return _project_inference_response(response, canonical_id)


def configure_inference(team_id: object, payload: object) -> transport.TeamResponse:
    """Forward the closed, secret-free Team inference contract."""
    canonical_id = payloads.canonical_team_id(team_id)
    if not isinstance(payload, dict) or set(payload) != {"provider", "model"}:
        raise transport.TeamRequestError("inference requires only provider and model")
    provider = payload["provider"]
    model = payload["model"]
    try:
        selected_provider = models.canonical_provider(provider)
        selected_model = models.canonical_model(selected_provider, model)
    except models.ModelProviderError as exc:
        raise transport.TeamRequestError(str(exc)) from None
    if provider != selected_provider:
        raise transport.TeamRequestError("model provider must be canonical")
    response = transport.call(
        "PUT",
        f"/v1/teams/{canonical_id}/inference",
        {"provider": selected_provider, "model": selected_model},
    )
    projected = _project_inference_response(response, canonical_id, expected=(selected_provider, selected_model))
    return _changed(projected, canonical_id, "inference")


def chat(
    team_id: object,
    payload: object,
    *,
    provider: str,
    api_key: str,
    progress: Callable[[dict[str, object]], None],
) -> transport.TeamResponse:
    """Send a turn whose JSON is secret-free; the key uses the private authenticated header."""
    canonical_id = payloads.canonical_team_id(team_id)
    body = payloads.canonical_team_chat_body(payload)
    return transport.call_stream(
        "POST",
        f"/v1/teams/{canonical_id}/chat",
        body,
        timeout=CHAT_STREAM_TIMEOUT_SECONDS,
        max_body_bytes=MAX_CHAT_JSON_BODY_BYTES,
        bindings=transport.RequestBindings((provider, api_key)),
        progress=progress,
    )


def capability_plan(
    team_id: object,
    payload: object,
    *,
    provider: str,
    api_key: str,
) -> transport.TeamResponse:
    """Request one stateless plan over a caller-supplied closed public shortlist."""
    canonical_id = payloads.canonical_team_id(team_id)
    if not isinstance(payload, dict) or set(payload) != {"objective", "candidates"}:
        raise transport.TeamRequestError("capability plan requires only objective and candidates")
    return transport.call(
        "POST",
        f"/v1/teams/{canonical_id}/chat/capability-plan",
        payload,
        model_credential=(provider, api_key),
        timeout=CAPABILITY_PLAN_TIMEOUT_SECONDS,
        # Any admissible message is planned: the body bound covers its longest encoding (Team protocol turn.py).
        bounds=transport.ByteBounds(body=team_turn.MAX_CAPABILITY_PLAN_BODY_BYTES),
    )


def intent_route(
    team_id: object,
    payload: object,
    *,
    provider: str,
    api_key: str,
    decision_key: str | None = None,
) -> transport.TeamResponse:
    """Request one stateless route over an optional caller-supplied closed directory."""
    canonical_id = payloads.canonical_team_id(team_id)
    # A keyed classification may also describe installable Assistants (ADR-0077 amendment); Team checks the rest.
    if not isinstance(payload, dict) or set(payload) - {"installable"} != {
        "objective",
        "expected_intent",
        "candidates",
        "lifecycle_reference",
        "conversation",
        "locale",
    }:
        raise transport.TeamRequestError(
            "intent route requires objective, expected_intent, candidates, and lifecycle context"
        )
    return transport.call(
        "POST",
        f"/v1/teams/{canonical_id}/chat/intent-route",
        payload,
        model_credential=(provider, api_key),
        decision_key=decision_key,
        timeout=INTENT_ROUTE_TIMEOUT_SECONDS,
        bounds=transport.ByteBounds(body=team_turn.MAX_INTENT_ROUTE_BODY_BYTES),
    )


def stop_chat(team_id: object) -> transport.TeamResponse:
    canonical_id = payloads.canonical_team_id(team_id)
    return transport.call("POST", f"/v1/teams/{canonical_id}/chat/stop", {})


def pending_chat_integrations(team_id: object) -> transport.TeamResponse:
    canonical_id = payloads.canonical_team_id(team_id)
    return transport.call("GET", f"/v1/teams/{canonical_id}/chat/integrations")


def open_chat_human(team_id: object, locale: object) -> transport.TeamResponse:
    """Open the Team's pending human challenge with its request copy in one interface language (ADR-0091)."""
    canonical_id = payloads.canonical_team_id(team_id)
    return transport.call(
        "POST", f"/v1/teams/{canonical_id}/chat/human/challenge", {"locale": payloads.canonical_locale(locale)}
    )


def resume_chat_integrations(
    team_id: object,
    payload: object,
    *,
    provider: str,
    api_key: str,
    progress: Callable[[dict[str, object]], None],
) -> transport.TeamResponse:
    canonical_id = payloads.canonical_team_id(team_id)
    body = payloads.canonical_integration_resume(payload)
    return transport.call_stream(
        "POST",
        f"/v1/teams/{canonical_id}/chat/integrations",
        body,
        timeout=CHAT_STREAM_TIMEOUT_SECONDS,
        bindings=transport.RequestBindings((provider, api_key)),
        progress=progress,
    )


def resume_chat_human(
    team_id: object,
    payload: object,
    *,
    provider: str,
    api_key: str,
    progress: Callable[[dict[str, object]], None],
    assurance: dict[str, str] | None = None,
) -> transport.TeamResponse:
    canonical_id = payloads.canonical_team_id(team_id)
    body = payloads.canonical_human_resume(payload)
    if assurance is not None:
        canonical_assurance = payloads.canonical_human_assurance(assurance)
        if (
            body.get("decision") != "submit"
            or body.get("value") is not True
            or canonical_assurance["challenge_id"] != body["challenge_id"]
        ):
            raise transport.TeamRequestError("human assurance does not match the continuation")
    else:
        canonical_assurance = None
    response = transport.call_stream(
        "POST",
        f"/v1/teams/{canonical_id}/chat/human",
        body,
        timeout=CHAT_STREAM_TIMEOUT_SECONDS,
        max_body_bytes=MAX_CHAT_JSON_BODY_BYTES,
        bindings=transport.RequestBindings(
            (provider, api_key),
            canonical_assurance,
        ),
        progress=progress,
    )
    # An admitted answer may have stored an Input for the Team's Assistants, also one that paused again for the next
    # request (428) after sealing it.
    if transport.is_team_response(response) and response.status == 428:
        topics.team_changed(canonical_id, "integrations")
        return response
    return _changed(response, canonical_id, "integrations")


def list_assistants() -> transport.TeamResponse:
    """Return every admissible Assistant of the Space by identity and name."""
    return transport.call("GET", "/v1/assistants")


def team_assistant_registry(team_id: object) -> transport.TeamResponse:
    """Return one Team's admitted Assistants with the names, summaries, and Actions its own bindings declare."""
    canonical_id = payloads.canonical_team_id(team_id)
    return transport.call(
        "GET",
        f"/v1/teams/{canonical_id}/assistant-registry",
        bounds=transport.ByteBounds(response=team_contract.MAX_TEAM_REGISTRY_BYTES),
    )


def list_local_assistants() -> transport.TeamResponse:
    """Return unpublished snapshots exposed only by the Local Team controller."""
    return transport.call("GET", "/v1/local-assistants")


def _local_assistant_path(image_id: object) -> str:
    return f"/v1/local-assistants/{canonical_source_digest(image_id).removeprefix('sha256:')}"


def local_assistant_icon(image_id: object) -> transport.TeamAssetResponse:
    """Return the admitted PNG preview for one exact unpublished image."""
    return transport.call_asset(f"{_local_assistant_path(image_id)}/icon")


def local_assistant_summary(image_id: object, locale: object) -> transport.TeamResponse:
    """Return one exact unpublished image's summary in one interface language, read from its own pack."""
    return transport.call("GET", f"{_local_assistant_path(image_id)}/summary/{payloads.canonical_locale(locale)}")


def local_assistant_details(image_id: object, locale: object) -> transport.TeamResponse:
    """Return one exact unpublished image's page in one interface language, read from its own package and pack."""
    return transport.call("GET", f"{_local_assistant_path(image_id)}/details/{payloads.canonical_locale(locale)}")


def _assistant_path(team_id: object, assistant_id: object | None = None) -> str:
    canonical_id = payloads.canonical_team_id(team_id)
    base = f"/v1/teams/{canonical_id}/assistants"
    return base if assistant_id is None else f"{base}/{payloads.canonical_assistant_id(assistant_id)}"


def list_installed_assistants(team_id: object) -> transport.TeamResponse:
    return transport.call("GET", _assistant_path(team_id))


def assistant_icon(team_id: object, assistant_id: object) -> transport.TeamAssetResponse:
    return transport.call_asset(f"{_assistant_path(team_id, assistant_id)}/icon")


def assistant_summary(team_id: object, assistant_id: object, locale: object) -> transport.TeamResponse:
    """Return one installed Assistant's summary in one interface language, read from its binding's pack."""
    return transport.call(
        "GET", f"{_assistant_path(team_id, assistant_id)}/summary/{payloads.canonical_locale(locale)}"
    )


def assistant_details(team_id: object, assistant_id: object, locale: object) -> transport.TeamResponse:
    """Return one installed Assistant's page in one interface language, read from its exact binding and pack."""
    return transport.call(
        "GET", f"{_assistant_path(team_id, assistant_id)}/details/{payloads.canonical_locale(locale)}"
    )


def install_assistant(team_id: object, payload: object) -> transport.TeamResponse:
    if not isinstance(payload, dict) or set(payload) != {"assistant_id", "source_digest"}:
        raise transport.TeamRequestError("request body must contain only assistant_id and source_digest")
    assistant_id = payloads.canonical_assistant_id(payload["assistant_id"])
    source_digest = canonical_source_digest(payload["source_digest"])
    response = transport.call(
        "POST",
        _assistant_path(team_id),
        {"assistant_id": assistant_id, "source_digest": source_digest},
        timeout=ASSISTANT_INSTALL_TIMEOUT_SECONDS,
    )
    return _changed(response, payloads.canonical_team_id(team_id), "inventory", "integrations", registry=True)


def _install_local(team_id: object, payload: object, route: str) -> transport.TeamResponse:
    if not isinstance(payload, dict) or set(payload) != {"image_id"}:
        raise transport.TeamRequestError("request body must contain only image_id")
    image_id = canonical_source_digest(payload["image_id"])
    response = transport.call(
        "POST",
        f"{_assistant_path(team_id)}/{route}",
        {"image_id": image_id},
        timeout=ASSISTANT_INSTALL_TIMEOUT_SECONDS,
    )
    return _changed(response, payloads.canonical_team_id(team_id), "inventory", "integrations", registry=True)


def install_local_assistant(team_id: object, payload: object) -> transport.TeamResponse:
    return _install_local(team_id, payload, "local")


def install_fresh_local_assistant(team_id: object, payload: object) -> transport.TeamResponse:
    return _install_local(team_id, payload, "local/fresh")


def uninstall_assistant(team_id: object, assistant_id: object) -> transport.TeamResponse:
    response = transport.call("DELETE", _assistant_path(team_id, assistant_id))
    return _changed(response, payloads.canonical_team_id(team_id), "inventory", "integrations", registry=True)


def _files_path(team_id: object, file_id: object | None = None) -> str:
    canonical_id = payloads.canonical_team_id(team_id)
    base = f"/v1/teams/{canonical_id}/files"
    if file_id is None:
        return base
    return f"{base}/{payloads.canonical_file_id(file_id)}"


def _project_storage_response(
    response: transport.TeamResponse,
    *,
    team_id: str,
    kind: str,
) -> transport.TeamResponse:
    if not 200 <= response.status < 300:
        error_body = {
            key: value
            for key in ("detail", "error", "code")
            if isinstance((value := response.body.get(key)), str) and 0 < len(value) <= 500
        }
        if not error_body:
            error_body = {"detail": "team request failed"}
        return transport.TeamResponse(response.status, error_body)
    body = team_contract.project_storage_response(
        response.body,
        kind=kind,
        expected_team_id=team_id,
    )
    if body is None:
        log.warning("team returned an invalid storage response (%s)", kind)
        return transport.TeamResponse(502, {"detail": "team unavailable"})
    return transport.TeamResponse(response.status, body)


def upload_file(team_id: object, filename: object, media_type: object, content: object) -> transport.TeamResponse:
    canonical_id = payloads.canonical_team_id(team_id)
    safe_filename = canonical_filename(filename)
    safe_media_type = canonical_media_type(media_type)
    if not isinstance(content, bytes) or not content:
        raise transport.TeamRequestError("file must contain bytes")
    if len(content) > MAX_FILE_UPLOAD_BYTES:
        raise transport.TeamRequestError(f"file exceeds {MAX_FILE_UPLOAD_BYTES} bytes")
    response = transport.call_raw(
        "POST",
        _files_path(canonical_id),
        content,
        filename=safe_filename,
        media_type=safe_media_type,
    )
    return _project_storage_response(response, team_id=canonical_id, kind="upload")


def list_files(team_id: object) -> transport.TeamResponse:
    canonical_id = payloads.canonical_team_id(team_id)
    response = transport.call("GET", _files_path(canonical_id))
    return _project_storage_response(response, team_id=canonical_id, kind="list")


# The closed refusals of a file preview Admin forwards: the file is absent or collected, has no preview, or the preview
# could not run now; Team's busy answer keeps its bounded retry delay. Anything else is Team being unavailable.
_PREVIEW_REFUSALS = {
    404: frozenset({"file-not-found", "team-not-found"}),
    422: frozenset({"file-preview-unsupported"}),
    503: frozenset({"file-preview-busy", "file-preview-unavailable"}),
}
# The closed refusals of a file download: the file came from the web and its Supervisor has not acknowledged it, it is
# absent or collected, or Team's downloads are all under way.
_CONTENT_REFUSALS = {
    403: frozenset({"file-acknowledgement-required"}),
    404: frozenset({"file-not-found", "team-not-found"}),
    503: frozenset({"file-download-busy"}),
}
_BUSY_CODES = frozenset({"file-preview-busy", "file-download-busy"})
MAX_PREVIEW_RETRY_MS = 2000


def _file_bytes(
    response: transport.TeamAssetResponse, refusals: dict[int, frozenset[str]], detail: str
) -> transport.TeamAssetResponse:
    """Team's file bytes as they came, or its closed refusal with a busy answer's bounded retry delay."""
    if response.contents is not None:
        return response
    code = response.error.get("code")
    if response.status not in refusals or code not in refusals[response.status]:
        return transport.TeamAssetResponse(502, None, {"detail": "team unavailable"})
    error: dict[str, object] = {"detail": detail, "code": code}
    retry = response.error.get("retry_after_ms")
    if code in _BUSY_CODES and type(retry) is int and 1 <= retry <= MAX_PREVIEW_RETRY_MS:
        error["retry_after_ms"] = retry
    return transport.TeamAssetResponse(response.status, None, error)


def file_preview(team_id: object, file_id: object) -> transport.TeamAssetResponse:
    """One Team file's sanitized image rendition, or its closed refusal (ADR-0093)."""
    response = transport.call_preview(f"{_files_path(team_id, file_id)}/preview")
    return _file_bytes(response, _PREVIEW_REFUSALS, "file preview unavailable")


def file_page_preview(team_id: object, file_id: object, page: object) -> transport.TeamAssetResponse:
    """One page of a Team PDF as a sanitized rendition with the page count, or its closed refusal (ADR-0093)."""
    canonical_page = preview_contract.canonical_page(page)
    if canonical_page is None:
        raise transport.TeamRequestError("page must be a number from 1 to 50")
    response = transport.call_page_preview(f"{_files_path(team_id, file_id)}/pages/{canonical_page}/preview")
    return _file_bytes(response, _PREVIEW_REFUSALS, "file preview unavailable")


# The closed refusals of an acknowledgement: no Supervisor made the request, the file is absent or collected, or it did
# not come from the web.
_ACKNOWLEDGEMENT_REFUSALS = {
    403: frozenset({"file-acknowledgement-required"}),
    404: frozenset({"file-not-found", "team-not-found"}),
    409: frozenset({"file-not-from-web"}),
}


def acknowledge_file(team_id: object, file_id: object) -> transport.TeamResponse:
    """Record the Supervisor's acknowledgement of one file from the web before its original is saved (ADR-0117 §7)."""
    canonical_file = payloads.canonical_file_id(file_id)
    response = transport.call("POST", f"{_files_path(team_id, canonical_file)}/acknowledgement")
    if response.status == 200 and response.body == {"file_id": canonical_file, "acknowledged": True}:
        return response
    code = response.body.get("code")
    if response.status in _ACKNOWLEDGEMENT_REFUSALS and code in _ACKNOWLEDGEMENT_REFUSALS[response.status]:
        return transport.TeamResponse(response.status, {"detail": "file acknowledgement unavailable", "code": code})
    return transport.TeamResponse(502, {"detail": "team unavailable"})


def file_content(team_id: object, file_id: object) -> transport.TeamAssetResponse:
    """One Team file's original, verified against its digest, or its closed refusal (ADR-0093)."""
    response = transport.call_content(f"{_files_path(team_id, file_id)}/content")
    return _file_bytes(response, _CONTENT_REFUSALS, "file download unavailable")


# The closed refusals of a Browser view: the Team runs no Browser task or no such Team exists, or the view is busy or
# unavailable (ADR-0117, M2 Watch).
_VIEW_REFUSALS = {
    404: frozenset({view_contract.NOT_RUNNING, "team-not-found"}),
    503: frozenset({view_contract.BUSY, view_contract.UNAVAILABLE}),
}


def open_browser_view(team_id: object) -> transport.TeamResponse:
    """The view id of the Browser task the Team runs now, for the Supervisor to watch its screen."""
    canonical_id = payloads.canonical_team_id(team_id)
    response = transport.call("POST", f"/v1/teams/{canonical_id}/browser/view")
    # Team names its trace beside the view; the page receives the view alone.
    if response.status == 200 and transport.is_closed_traced(response.body, {"view_id"}):
        view = view_contract.canonical_view({"view_id": response.body["view_id"]})
        if view is not None:
            return transport.TeamResponse(200, view)
    code = response.body.get("code")
    if response.status in _VIEW_REFUSALS and code in _VIEW_REFUSALS[response.status]:
        return transport.TeamResponse(response.status, {"detail": "browser view unavailable", "code": code})
    return transport.TeamResponse(502, {"detail": "team unavailable"})
