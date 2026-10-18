"""Bounded authenticated HTTP transport from Admin to team."""

import base64
import contextlib
import hashlib
import http.client
import json
import logging
import os
import re
import threading
from collections.abc import Callable
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from urllib.parse import quote, urlparse

import models
import supervisor as local_supervisor

from protocol.http.v1 import browser_view as view_contract
from protocol.http.v1 import content as content_contract
from protocol.http.v1 import preview as preview_contract
from protocol.http.v1 import progress as progress_contract
from protocol.http.v1 import supervisor as supervisor_contract
from protocol.http.v1 import websocket as team_http

log = logging.getLogger("shimpz-admin")

URL = os.environ.get("SHIMPZ_TEAM_URL", "http://team:7077")
TOKEN_FILE = os.environ.get("SHIMPZ_TEAM_TOKEN_FILE", "/run/shimpz-local/token")

MAX_JSON_BODY_BYTES = 16 * 1024
MAX_JSON_RESPONSE_BYTES = 256 * 1024
MAX_ASSISTANT_ICON_BYTES = 1024 * 1024
CONTROL_TIMEOUT_SECONDS = 180
FILE_NAME_HEADER = "X-Shimpz-Filename"
# A file original's SHA-256 as Team sends it (RFC 9530): exactly one standard base64 digest.
_REPR_DIGEST = re.compile(r"sha-256=:([A-Za-z0-9+/]{43}=):")


@dataclass(frozen=True, slots=True)
class _SupervisorSession:
    value: str
    local_identity: local_supervisor.LocalIdentity
    authority_kind: str


@dataclass(frozen=True, slots=True)
class ByteBounds:
    """The largest request body Admin sends, and the largest answer it reads, on one Team call."""

    body: int = MAX_JSON_BODY_BYTES
    response: int = MAX_JSON_RESPONSE_BYTES


DEFAULT_BOUNDS = ByteBounds()


@dataclass(frozen=True, slots=True, repr=False)
class RequestBindings:
    model_credential: tuple[str, str] | None = None
    human_assurance: dict[str, str] | None = None
    # The Supervisor's TypeSafe key, sent only with intent classification (ADR-0077).
    decision_key: str | None = None
    # Admin's Routine identity and the run's lease token: the run segment is signed by it, never by a session.
    routine: tuple[local_supervisor.LocalIdentity, str] | None = None


_NO_BINDINGS = RequestBindings()

_SUPERVISOR_SESSION: ContextVar[_SupervisorSession | None] = ContextVar(
    "shimpz_supervisor_session",
    default=None,
)


class TeamRequestError(ValueError):
    """The browser supplied an invalid id or request body; no Team call was made."""


@dataclass(frozen=True, slots=True)
class _Entity:
    """A request's body with its media type and, for an uploaded file, its name."""

    body: bytes | None
    content_type: str | None
    filename: str | None = None


@dataclass(frozen=True)
class TeamResponse:
    status: int
    body: dict[str, object]


def is_team_response(value: object) -> bool:
    """Admit a Team response whose status is an integer, never a boolean."""
    return isinstance(value, TeamResponse) and isinstance(value.status, int) and not isinstance(value.status, bool)


def is_trace_id(value: object) -> bool:
    """Admit one Team trace identifier."""
    return isinstance(value, str) and team_http.HEX_ID_RE.fullmatch(value) is not None


def trace_envelope(body: dict[str, object], fields: set[str]) -> set[str]:
    """Return a closed envelope's fields plus Team's optional trace identifier, refusing an invalid one."""
    if "trace_id" not in body:
        return set(fields)
    if not is_trace_id(body["trace_id"]):
        raise ValueError("Team trace identifier is invalid")
    return {*fields, "trace_id"}


def is_closed_traced(body: dict[str, object], fields: set[str] | frozenset[str], *, team_id: str | None = None) -> bool:
    """Admit a closed envelope of exactly `fields` plus Team's required trace identifier, and of `team_id` if given."""
    return (
        set(body) == {*fields, "trace_id"}
        and is_trace_id(body["trace_id"])
        and (team_id is None or body["team_id"] == team_id)
    )


@dataclass(frozen=True)
class TeamAssetResponse:
    status: int
    contents: bytes | None
    error: dict[str, object]
    media_type: str = "image/png"
    # A PDF page's rendition also names its document's page count.
    page_count: int | None = None
    # A Browser view frame names its number.
    frame: int | None = None


ProgressSink = Callable[[dict[str, object]], None]


@dataclass(frozen=True)
class _TokenCache:
    path: Path
    identity: tuple[int, int, int, int]
    token: str


_token_cache_lock = threading.Lock()
_token_cache: _TokenCache | None = None


@contextmanager
def supervisor_session(
    value: object,
    *,
    local_identity: local_supervisor.LocalIdentity | None,
    authority_kind: str = "session",
):
    """Bind one already-validated human session to downstream Team calls in this request."""
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 2048
        or not value.isascii()
        or any(not 0x20 <= ord(character) <= 0x7E for character in value)
    ):
        raise TeamRequestError("Supervisor session is unavailable")
    if authority_kind not in {"session", "host-reset"}:
        raise TeamRequestError("Supervisor authority kind is invalid")
    try:
        validated = local_supervisor.identity_from_record(
            {
                "supervisor_id": local_identity.supervisor_id,
                "supervisor_signing_key": local_identity.private_key_hex,
            }
        )
    except (AttributeError, local_supervisor.SupervisorAuthorityError) as exc:
        raise TeamRequestError("Local Supervisor identity is unavailable") from exc
    reset = _SUPERVISOR_SESSION.set(_SupervisorSession(value, validated, authority_kind))
    try:
        yield
    finally:
        _SUPERVISOR_SESSION.reset(reset)


def _local_assertion(
    method: str,
    path: str,
    body: bytes | None,
    *,
    content_type: str | None,
    filename: str | None,
    bindings: RequestBindings,
) -> str:
    binding = _SUPERVISOR_SESSION.get()
    if binding is None:
        return ""
    return local_supervisor.sign_request(
        binding.local_identity,
        binding.value,
        request=_request_binding(method, path, body, content_type=content_type, filename=filename, bindings=bindings),
        authority_kind=binding.authority_kind,
    )


def _request_binding(
    method: str,
    path: str,
    body: bytes | None,
    *,
    content_type: str | None,
    filename: str | None,
    bindings: RequestBindings,
) -> local_supervisor.RequestBinding:
    if filename is not None:
        if body is None or content_type is None:
            raise local_supervisor.SupervisorAuthorityError("Local Supervisor file binding is invalid")
        body_binding = local_supervisor.file_body(body, filename, content_type)
    elif body is not None:
        body_binding = local_supervisor.json_body(body)
    else:
        body_binding = local_supervisor.empty_body()
    return local_supervisor.RequestBinding(
        method=method,
        path=path,
        body=body_binding,
        model=local_supervisor.model_binding(bindings.model_credential),
        decision=local_supervisor.decision_binding(bindings.decision_key),
        assurance=bindings.human_assurance,
    )


def _token_identity(path: Path) -> tuple[int, int, int, int]:
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_size


def _read_token_file(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def _team_token() -> str:
    global _token_cache
    path = Path(TOKEN_FILE)
    identity = _token_identity(path)
    with _token_cache_lock:
        if _token_cache is not None and (_token_cache.path, _token_cache.identity) == (path, identity):
            return _token_cache.token
        token = _read_token_file(path)
        if not token:
            raise OSError("empty team bearer")
        if _token_identity(path) != identity:
            raise OSError("team bearer changed while reading")
        _token_cache = _TokenCache(path, identity, token)
        return token


def _encode_payload(payload: object | None, *, max_bytes: int = MAX_JSON_BODY_BYTES) -> bytes | None:
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise TeamRequestError("request body must be a JSON object")
    try:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise TeamRequestError("request body must be valid JSON") from exc
    if len(body) > max_bytes:
        raise TeamRequestError(f"request body exceeds {max_bytes} bytes")
    return body


def _endpoint() -> tuple[str, int]:
    try:
        parsed = urlparse(URL)
    except ValueError as exc:
        raise OSError("invalid team endpoint") from exc
    if (
        parsed.scheme != "http"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise OSError("invalid team endpoint")
    try:
        return parsed.hostname, parsed.port or 7077
    except ValueError as exc:
        raise OSError("invalid team endpoint") from exc


def _decode_response(response: http.client.HTTPResponse, max_bytes: int = MAX_JSON_RESPONSE_BYTES) -> dict[str, object]:
    # Team answers every request with one JSON object; a 204 carries none, whatever its framing claims.
    if response.status == 204:
        raise OSError("invalid team response")
    content_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().lower()
    if content_type != "application/json":
        raise OSError("invalid team response")

    raw_length = response.getheader("Content-Length")
    if raw_length is not None:
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise OSError("invalid team response") from exc
        if length < 0 or length > max_bytes:
            raise OSError("invalid team response")

    raw = response.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise OSError("invalid team response")
    try:
        body = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError, RecursionError) as exc:
        raise OSError("invalid team response") from exc
    if not isinstance(body, dict):
        raise OSError("invalid team response")
    return body


def _private_key(value: object, message: str) -> str:
    encoded = value.encode("ascii") if isinstance(value, str) and value.isascii() else b""
    if not 16 <= len(encoded) <= 8 * 1024 or any(not 33 <= byte <= 126 for byte in encoded):
        raise OSError(message)
    return value


def _request_headers(
    method: str,
    path: str,
    body: bytes | None,
    *,
    accept: str,
    content_type: str | None,
    filename: str | None,
    bindings: RequestBindings,
) -> dict[str, str]:
    headers = {"Accept": accept, "Authorization": f"Bearer {_team_token()}"}
    if content_type is not None:
        headers["Content-Type"] = content_type
    if filename is not None:
        headers[FILE_NAME_HEADER] = quote(filename, safe="")
    if bindings.model_credential is not None:
        provider, api_key = bindings.model_credential
        encoded_key = api_key.encode("ascii") if isinstance(api_key, str) and api_key.isascii() else b""
        if (
            provider not in models.PROVIDERS
            or not 16 <= len(encoded_key) <= 8 * 1024
            or any(not 33 <= byte <= 126 for byte in encoded_key)
        ):
            raise OSError("invalid private model credential")
        headers["X-Shimpz-Model-Provider"] = provider
        headers["X-Shimpz-Model-Api-Key"] = api_key
    if bindings.decision_key is not None:
        headers["X-Shimpz-Decision-Api-Key"] = _private_key(
            bindings.decision_key, "invalid private decision credential"
        )
    if bindings.routine is not None:
        identity, lease_token = bindings.routine
        request = _request_binding(method, path, body, content_type=content_type, filename=filename, bindings=bindings)
        routine_assertion = local_supervisor.sign_routine_request(identity, lease_token, request=request)
        headers[supervisor_contract.ROUTINE_ASSERTION_HEADER] = f"Bearer {routine_assertion}"
        return headers
    assertion = _local_assertion(
        method,
        path,
        body,
        content_type=content_type,
        filename=filename,
        bindings=bindings,
    )
    if assertion:
        headers[supervisor_contract.ASSERTION_HEADER] = f"Bearer {assertion}"
    return headers


@dataclass(frozen=True, slots=True)
class _Reading[Result: (TeamResponse, TeamAssetResponse)]:
    """How one kind of Team answer is accepted, decoded, named in logs, and answered when Team is unavailable."""

    accept: str
    decode: Callable[[http.client.HTTPResponse], Result]
    unavailable: Callable[[], Result]
    subject: str
    decode_errors: tuple[type[Exception], ...] = ()


def _team_unavailable() -> TeamResponse:
    return TeamResponse(502, {"detail": "team unavailable"})


def _forget_token() -> None:
    """Drop the cached bearer, so the next request reads the token file Team wrote on its latest start."""
    global _token_cache
    with _token_cache_lock:
        _token_cache = None


def _bearer_refused(response: http.client.HTTPResponse) -> None:
    """Accept only Team's exact bearer refusal; any other 401 is an invalid answer."""
    body = _decode_response(response)
    if body.get("error") != "authentication required":
        raise OSError("invalid team authentication response")


def _exchange[Result: (TeamResponse, TeamAssetResponse)](
    method: str,
    path: str,
    entity: _Entity,
    *,
    timeout: int,
    bindings: RequestBindings,
    reading: _Reading[Result],
) -> Result:
    """One authenticated Team exchange, sent again once with a re-read bearer when Team refuses the cached one.

    Team issues a fresh bearer on every start and checks it before it reads the request or verifies its assertion, so
    resending the same request is safe for every method. A second refusal answers unavailable.
    """
    result = _exchange_once(method, path, entity, timeout=timeout, bindings=bindings, reading=reading)
    if result is not None:
        return result
    _forget_token()
    result = _exchange_once(method, path, entity, timeout=timeout, bindings=bindings, reading=reading)
    if result is not None:
        return result
    log.warning("%s was refused the Team bearer twice (%s)", reading.subject, method)
    return reading.unavailable()


def _exchange_once[Result: (TeamResponse, TeamAssetResponse)](
    method: str,
    path: str,
    entity: _Entity,
    *,
    timeout: int,
    bindings: RequestBindings,
    reading: _Reading[Result],
) -> Result | None:
    """One Team exchange; None when Team refused the bearer, and unavailable on any other failure."""
    try:
        host, port = _endpoint()
        headers = _request_headers(
            method,
            path,
            entity.body,
            accept=reading.accept,
            content_type=entity.content_type,
            filename=entity.filename,
            bindings=bindings,
        )
        connection = http.client.HTTPConnection(host, port, timeout=timeout)
    except OSError, UnicodeError, http.client.HTTPException:
        log.warning("%s failed (%s)", reading.subject, method)
        return reading.unavailable()
    try:
        # Deliberately request-scoped: Admin calls can run concurrently, while a shared HTTP/1.1
        # socket would require serialization and could retain an authenticated connection across
        # bearer rotation. The local bridge avoids a TLS handshake, so isolation wins over pooling.
        connection.request(method, path, body=entity.body, headers=headers)
        response = connection.getresponse()
        if not 200 <= response.status <= 599:
            raise OSError("invalid team status")
        if response.status == HTTPStatus.UNAUTHORIZED:
            _bearer_refused(response)
            log.info("%s %s %s -> Team refused the bearer", reading.subject, method, path)
            return None
        result = reading.decode(response)
    except (OSError, UnicodeError, http.client.HTTPException, *reading.decode_errors):
        # Exception text, bearer and bodies may contain internals. Never copy them into logs or JSON.
        log.warning("%s failed (%s)", reading.subject, method)
        return reading.unavailable()
    finally:
        try:
            connection.close()
        except OSError:
            log.warning("team connection close failed (%s)", method)
    log.info("%s %s %s -> HTTP %s", reading.subject, method, path, result.status)
    return result


def _request(
    method: str,
    path: str,
    entity: _Entity,
    *,
    timeout: int,
    bindings: RequestBindings = _NO_BINDINGS,
    max_response_bytes: int = MAX_JSON_RESPONSE_BYTES,
) -> TeamResponse:
    return _exchange(
        method,
        path,
        entity,
        timeout=timeout,
        bindings=bindings,
        reading=_Reading(
            "application/json",
            lambda response: TeamResponse(response.status, _decode_response(response, max_response_bytes)),
            _team_unavailable,
            "team request",
        ),
    )


def _decode_image(response: http.client.HTTPResponse, media_types: frozenset[str], maximum: int) -> TeamAssetResponse:
    """One exactly framed image Team sent, or its JSON error; anything else is an invalid answer."""
    if response.status != HTTPStatus.OK:
        return TeamAssetResponse(response.status, None, _decode_response(response))
    content_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().lower()
    raw_length = response.getheader("Content-Length")
    if content_type not in media_types or raw_length is None:
        raise OSError("invalid Team asset response")
    try:
        length = int(raw_length)
    except ValueError as exc:
        raise OSError("invalid Team asset response") from exc
    if not 1 <= length <= maximum:
        raise OSError("invalid Team asset response")
    contents = response.read(maximum + 1)
    if len(contents) != length:
        raise OSError("invalid Team asset response")
    return TeamAssetResponse(HTTPStatus.OK, contents, {}, content_type)


def _decode_asset(response: http.client.HTTPResponse) -> TeamAssetResponse:
    return _decode_image(response, frozenset({"image/png"}), MAX_ASSISTANT_ICON_BYTES)


def _decode_preview(response: http.client.HTTPResponse) -> TeamAssetResponse:
    """A file preview: exactly a JPEG or PNG within the preview bound whose bytes carry that type's signature."""
    result = _decode_image(response, frozenset(preview_contract.SIGNATURES), preview_contract.MAX_PREVIEW_BYTES)
    if result.contents is not None and not result.contents.startswith(preview_contract.SIGNATURES[result.media_type]):
        raise OSError("invalid Team asset response")
    return result


def _decode_page_preview(response: http.client.HTTPResponse) -> TeamAssetResponse:
    """A PDF page's preview: a file preview whose page count header names 1 to the page ceiling."""
    result = _decode_preview(response)
    if result.contents is None:
        return result
    page_count = preview_contract.canonical_page(response.getheader(preview_contract.PAGE_COUNT_HEADER))
    if page_count is None:
        raise OSError("invalid Team asset response")
    return TeamAssetResponse(result.status, result.contents, {}, result.media_type, page_count)


def _decode_browser_frame(response: http.client.HTTPResponse) -> TeamAssetResponse:
    """A Browser view frame: no content when none came, or exactly one PNG within its bound, numbered in its header."""
    if response.status == HTTPStatus.NO_CONTENT:
        length = response.getheader("Content-Length")
        if (length is not None and length != "0") or response.getheader("Transfer-Encoding") is not None:
            raise OSError("invalid Team browser frame response")
        if response.read(1):
            raise OSError("invalid Team browser frame response")
        return TeamAssetResponse(HTTPStatus.NO_CONTENT, None, {})
    result = _decode_image(response, frozenset({"image/png"}), view_contract.MAX_FRAME_BYTES)
    if result.contents is None:
        return result
    number = view_contract.canonical_cursor(response.getheader(view_contract.FRAME_HEADER))
    framing = {"frame": number, "length": len(result.contents)}
    if view_contract.canonical_frame(framing) is None or not result.contents.startswith(view_contract.PNG_SIGNATURE):
        raise OSError("invalid Team browser frame response")
    return TeamAssetResponse(HTTPStatus.OK, result.contents, {}, "image/png", frame=number)


def _decode_content(response: http.client.HTTPResponse) -> TeamAssetResponse:
    """A file's original: exactly an octet stream of its declared length whose SHA-256 is its declared digest.

    It is read whole, within the upload bound, and verified before Admin sends any of it on.
    """
    if response.status != HTTPStatus.OK:
        return TeamAssetResponse(response.status, None, _decode_response(response))
    content_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().lower()
    raw_length = response.getheader("Content-Length") or ""
    digest = _REPR_DIGEST.fullmatch(response.getheader("Repr-Digest") or "")
    if content_type != "application/octet-stream" or not raw_length.isascii() or not raw_length.isdigit() or not digest:
        raise OSError("invalid Team file content response")
    sha256 = base64.b64decode(digest[1], validate=True).hex()
    framing = content_contract.canonical_framing({"length": int(raw_length), "sha256": sha256})
    if framing is None:
        raise OSError("invalid Team file content response")
    contents = response.read(content_contract.MAX_CONTENT_BYTES + 1)
    if len(contents) != framing["length"] or hashlib.sha256(contents).hexdigest() != sha256:
        raise OSError("invalid Team file content response")
    return TeamAssetResponse(HTTPStatus.OK, contents, {}, "application/octet-stream")


def _asset_unavailable() -> TeamAssetResponse:
    return TeamAssetResponse(HTTPStatus.BAD_GATEWAY, None, {"detail": "team unavailable"})


_ASSET_READING = _Reading("image/png", _decode_asset, _asset_unavailable, "Team asset request")
_PREVIEW_READING = _Reading("image/jpeg, image/png", _decode_preview, _asset_unavailable, "Team file preview request")
_PAGE_PREVIEW_READING = _Reading(
    "image/jpeg, image/png", _decode_page_preview, _asset_unavailable, "Team file page preview request"
)
_CONTENT_READING = _Reading(
    "application/octet-stream", _decode_content, _asset_unavailable, "Team file content request"
)


_BROWSER_FRAME_READING = _Reading("image/png", _decode_browser_frame, _asset_unavailable, "Team browser frame request")


def _request_asset(path: str, reading: _Reading[TeamAssetResponse] = _ASSET_READING) -> TeamAssetResponse:
    """GET one Team asset with no body and no credential binding, read by `reading`."""
    return _exchange(
        "GET",
        path,
        _Entity(None, None),
        timeout=CONTROL_TIMEOUT_SECONDS,
        bindings=_NO_BINDINGS,
        reading=reading,
    )


def _decode_stream(
    response: http.client.HTTPResponse,
    progress: ProgressSink,
) -> TeamResponse:
    content_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().lower()
    if (
        response.status != HTTPStatus.OK
        or content_type != "application/x-ndjson"
        or response.getheader("Content-Length") is not None
        or response.getheader("Transfer-Encoding") != "chunked"
    ):
        raise OSError("invalid Team chat stream")
    sequence = 0
    event_count = 0
    byte_count = 0
    while True:
        raw = response.readline(progress_contract.MAX_LINE_BYTES + 1)
        if not raw:
            raise OSError("truncated Team chat stream")
        byte_count += len(raw)
        if byte_count > progress_contract.MAX_STREAM_BYTES:
            raise OSError("Team chat stream exceeded its limit")
        record = progress_contract.decode_line(raw)
        if record["type"] == "terminal":
            if response.read(1):
                raise OSError("Team chat stream continued after terminal")
            return TeamResponse(record["status"], record["body"])
        event_count += 1
        if event_count > progress_contract.MAX_EVENTS or record["seq"] != sequence + 1:
            raise OSError("invalid Team chat progress order")
        sequence = record["seq"]
        event = {key: value for key, value in record.items() if key != "type"}
        with contextlib.suppress(Exception):
            progress(event)


def _stream_request(
    method: str,
    path: str,
    body: bytes,
    *,
    timeout: int,
    bindings: RequestBindings,
    progress: ProgressSink,
) -> TeamResponse:
    return _exchange(
        method,
        path,
        _Entity(body, "application/json"),
        timeout=timeout,
        bindings=bindings,
        reading=_Reading(
            "application/x-ndjson",
            lambda response: _decode_stream(response, progress),
            _team_unavailable,
            "team chat stream",
            (progress_contract.ProgressContractError,),
        ),
    )


def call(
    method: str,
    path: str,
    payload: object | None = None,
    *,
    timeout: int = CONTROL_TIMEOUT_SECONDS,
    model_credential: tuple[str, str] | None = None,
    decision_key: str | None = None,
    bounds: ByteBounds = DEFAULT_BOUNDS,
) -> TeamResponse:
    body = _encode_payload(payload, max_bytes=bounds.body)
    return _request(
        method,
        path,
        _Entity(body, "application/json" if body is not None else None),
        timeout=timeout,
        bindings=RequestBindings(model_credential, decision_key=decision_key),
        max_response_bytes=bounds.response,
    )


def call_asset(path: str) -> TeamAssetResponse:
    return _request_asset(path)


def call_preview(path: str) -> TeamAssetResponse:
    return _request_asset(path, _PREVIEW_READING)


def call_page_preview(path: str) -> TeamAssetResponse:
    return _request_asset(path, _PAGE_PREVIEW_READING)


def call_content(path: str) -> TeamAssetResponse:
    return _request_asset(path, _CONTENT_READING)


def call_browser_frame(path: str) -> TeamAssetResponse:
    return _request_asset(path, _BROWSER_FRAME_READING)


def call_stream(
    method: str,
    path: str,
    payload: object,
    *,
    timeout: int,
    max_body_bytes: int = MAX_JSON_BODY_BYTES,
    bindings: RequestBindings,
    progress: ProgressSink,
) -> TeamResponse:
    body = _encode_payload(payload, max_bytes=max_body_bytes)
    if body is None:
        raise TeamRequestError("stream request body is required")
    return _stream_request(
        method,
        path,
        body,
        timeout=timeout,
        bindings=bindings,
        progress=progress,
    )


def call_raw(
    method: str,
    path: str,
    body: bytes,
    *,
    filename: str,
    media_type: str,
) -> TeamResponse:
    if not isinstance(body, bytes) or not isinstance(filename, str) or not isinstance(media_type, str):
        raise TeamRequestError("raw file request is invalid")
    return _request(method, path, _Entity(body, media_type, filename), timeout=CONTROL_TIMEOUT_SECONDS)
