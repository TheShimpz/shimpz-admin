"""A Team's files: the upload, a file's previews, and its download stay HTTP; their metadata are session calls."""

import threading
import weakref

import anyio
import browser
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from python_multipart.exceptions import ParseError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser
from starlette.types import Receive, Scope, Send
from team import bridge as team
from team import http as team_http
from team import transport

from protocol.http.v1 import preview as preview_contract

MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024
MAX_MULTIPART_BODY_BYTES = team.MAX_FILE_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES
# At most this many originals, each within the upload bound, are held to be sent at once, and a browser that has not
# taken one within DOWNLOAD_SEND_SECONDS of its start is cut off.
MAX_DOWNLOADS = 2
DOWNLOAD_SEND_SECONDS = 120
DOWNLOAD_RETRY_MS = 250
_DOWNLOADS = threading.BoundedSemaphore(MAX_DOWNLOADS)
_NO_STORE = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
# A download is never a page: it is saved, never shown, and no other page may embed or read it.
DOWNLOAD_HEADERS = {
    **_NO_STORE,
    "Content-Disposition": "attachment",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
}


class _MultipartBodyTooLargeError(OSError):
    pass


async def bounded_multipart_file(request: Request) -> tuple[str, str, bytes]:
    """Accept exactly one bounded file part and return no filesystem path."""
    content_types = request.headers.getlist("content-type")
    if len(content_types) != 1 or content_types[0].partition(";")[0].strip().lower() != "multipart/form-data":
        raise HTTPException(status_code=415, detail="content type must be multipart/form-data")

    content_lengths = request.headers.getlist("content-length")
    if len(content_lengths) > 1:
        raise HTTPException(status_code=400, detail="invalid content length")
    if content_lengths:
        raw_length = content_lengths[0]
        if not raw_length.isascii() or not raw_length.isdigit():
            raise HTTPException(status_code=400, detail="invalid content length")
        if int(raw_length) > MAX_MULTIPART_BODY_BYTES:
            raise HTTPException(status_code=413, detail="file upload too large")

    async def bounded_stream():
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_MULTIPART_BODY_BYTES:
                raise _MultipartBodyTooLargeError
            yield chunk

    try:
        form = await MultiPartParser(
            request.headers,
            bounded_stream(),
            max_files=1,
            max_fields=0,
            max_part_size=1024,
        ).parse()
    except _MultipartBodyTooLargeError:
        raise HTTPException(status_code=413, detail="file upload too large") from None
    except MultiPartException, ParseError:
        raise HTTPException(status_code=400, detail="invalid multipart body") from None

    try:
        items = form.multi_items()
        if len(items) != 1 or items[0][0] != "file" or not isinstance(items[0][1], UploadFile):
            raise HTTPException(status_code=400, detail="multipart body must contain only one file field")
        upload = items[0][1]
        with team_http.refused_as_bad_request():
            filename = team.canonical_filename(upload.filename)
            media_type = team.canonical_media_type(upload.content_type)
        content = await upload.read(team.MAX_FILE_UPLOAD_BYTES + 1)
        if not content:
            raise HTTPException(status_code=400, detail="file must contain bytes")
        if len(content) > team.MAX_FILE_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="file upload too large")
        return filename, media_type, content
    finally:
        await form.close()


def register(app: FastAPI) -> None:
    app.add_api_route("/api/teams/{team_id}/files", team_file_upload, methods=["POST"])
    app.add_api_route("/api/teams/{team_id}/files/{file_id}/preview", team_file_preview, methods=["GET"])
    app.add_api_route(
        "/api/teams/{team_id}/files/{file_id}/pages/{page}/preview", team_file_page_preview, methods=["GET"]
    )
    app.add_api_route("/api/teams/{team_id}/files/{file_id}/download", team_file_download, methods=["GET"])


def team_files_list(team_id: str):
    return team_http.response(lambda: team.list_files(team_id))


async def team_file_upload(team_id: str, request: Request):
    filename, media_type, content = await bounded_multipart_file(request)
    return await run_in_threadpool(team_http.response, lambda: team.upload_file(team_id, filename, media_type, content))


def team_file_delete(team_id: str, file_id: str):
    return team_http.response(lambda: team.delete_file(team_id, file_id))


def team_file_preview(team_id: str, file_id: str, request: Request) -> Response:
    """One Team file's sanitized image rendition for Admin's own page, never cached (ADR-0093).

    Only the page's own image load or script read reaches Team; Admin forwards exactly a JPEG or PNG within the preview
    bound, and otherwise a closed refusal.
    """
    if not browser.same_origin_image(request):
        return JSONResponse(status_code=403, content={"detail": "browser origin is not admitted"}, headers=_NO_STORE)
    with team_http.refused_as_bad_request():
        result = team.file_preview(team_id, file_id)
    return _rendition(result)


def team_file_page_preview(team_id: str, file_id: str, page: str, request: Request) -> Response:
    """One page of a Team PDF as a sanitized rendition for Admin's own page, with its page count (ADR-0093)."""
    if not browser.same_origin_image(request):
        return JSONResponse(status_code=403, content={"detail": "browser origin is not admitted"}, headers=_NO_STORE)
    with team_http.refused_as_bad_request():
        result = team.file_page_preview(team_id, file_id, page)
    return _rendition(result, {preview_contract.PAGE_COUNT_HEADER: str(result.page_count)})


def _rendition(result: transport.TeamAssetResponse, headers: dict[str, str] | None = None) -> Response:
    if result.contents is None:
        return JSONResponse(status_code=result.status, content=result.error, headers=_NO_STORE)
    return Response(
        content=result.contents, status_code=200, media_type=result.media_type, headers={**_NO_STORE, **(headers or {})}
    )


class _Slot:
    """One held download slot, released exactly once."""

    def __init__(self) -> None:
        self.held = True
        # Whether a download response took the slot over; the slot never refers to it, so it can be collected.
        self.taken = False

    def release(self) -> None:
        if self.held:
            self.held = False
            _DOWNLOADS.release()


class _Download(Response):
    """A verified original sent as an attachment, holding its download slot until the response ends however it ends.

    A browser that has not taken it within DOWNLOAD_SEND_SECONDS is cut off, and a response that is never sent releases
    its slot once it is dropped.
    """

    def __init__(self, contents: bytes, slot: _Slot) -> None:
        super().__init__(content=contents, media_type="application/octet-stream", headers=DOWNLOAD_HEADERS)
        self._slot = slot
        slot.taken = True
        weakref.finalize(self, slot.release)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            with anyio.move_on_after(DOWNLOAD_SEND_SECONDS):
                await super().__call__(scope, receive, send)
        finally:
            self._slot.release()


async def team_file_download(team_id: str, file_id: str, request: Request) -> Response:
    """One Team file's original for the Supervisor to save, or to read as text in the viewer (ADR-0093).

    Only Admin's own page reaches it. Team verifies the bytes against their digest and Admin verifies them again before
    sending any; at most MAX_DOWNLOADS are held at once, each from before Team is asked until its response ended.
    """
    if not browser.same_origin_download(request):
        return JSONResponse(status_code=403, content={"detail": "browser origin is not admitted"}, headers=_NO_STORE)
    if not _DOWNLOADS.acquire(blocking=False):
        busy = {
            "detail": "file download unavailable",
            "code": "file-download-busy",
            "retry_after_ms": DOWNLOAD_RETRY_MS,
        }
        return JSONResponse(status_code=503, content=busy, headers=_NO_STORE)
    slot = _Slot()
    try:
        with team_http.refused_as_bad_request():
            result = await run_in_threadpool(team.file_content, team_id, file_id)
        if result.contents is None:
            return JSONResponse(status_code=result.status, content=result.error, headers=_NO_STORE)
        return _Download(result.contents, slot)
    finally:
        # Only a download response takes the slot over; every other outcome releases it here.
        if not slot.taken:
            slot.release()
