"""Admin routes for a Team's files and their bounded browser file ingress at the Admin-to-Team boundary."""

from fastapi import FastAPI, HTTPException, Request
from python_multipart.exceptions import ParseError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser
from team import bridge as team
from team import http as team_http

MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024
MAX_MULTIPART_BODY_BYTES = team.MAX_FILE_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES


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
        try:
            filename = team.canonical_filename(upload.filename)
            media_type = team.canonical_media_type(upload.content_type)
        except team.TeamRequestError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        content = await upload.read(team.MAX_FILE_UPLOAD_BYTES + 1)
        if not content:
            raise HTTPException(status_code=400, detail="file must contain bytes")
        if len(content) > team.MAX_FILE_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="file upload too large")
        return filename, media_type, content
    finally:
        await form.close()


def register(app: FastAPI) -> None:
    app.add_api_route("/api/teams/{team_id}/files", team_files_list, methods=["GET"])
    app.add_api_route("/api/teams/{team_id}/files", team_file_upload, methods=["POST"])
    app.add_api_route("/api/teams/{team_id}/files/{file_id}", team_file_delete, methods=["DELETE"])


def team_files_list(team_id: str):
    return team_http.response(lambda: team.list_files(team_id))


async def team_file_upload(team_id: str, request: Request):
    filename, media_type, content = await bounded_multipart_file(request)
    return await run_in_threadpool(team_http.response, lambda: team.upload_file(team_id, filename, media_type, content))


def team_file_delete(team_id: str, file_id: str):
    return team_http.response(lambda: team.delete_file(team_id, file_id))
