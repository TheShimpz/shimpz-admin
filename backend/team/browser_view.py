"""A Browser task's screen over HTTP: the frames Admin's page shows the watching Supervisor (ADR-0117, M2 Watch).

A frame is binary, so it travels over HTTP rather than the session socket; the view it belongs to is opened over the
socket (`browser.view`). Only Admin's own page reaches a frame, and at most MAX_VIEWS frame requests are held at once,
each from before Team is asked until its response ended or VIEW_SEND_SECONDS passed.
"""

import threading
import weakref

import anyio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.types import Receive, Scope, Send
from team import bridge as team
from team import http as team_http

import browser
from protocol.http.v1 import browser_view as view_contract

MAX_VIEWS = 2
VIEW_SEND_SECONDS = 10
VIEW_RETRY_MS = 250
_VIEWS = threading.BoundedSemaphore(MAX_VIEWS)
_NO_STORE = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}


def register(app: FastAPI) -> None:
    app.add_api_route("/api/teams/{team_id}/browser/views/{view_id}/frames/{after}", browser_frame, methods=["GET"])


class _Slot:
    """One held frame slot, released exactly once."""

    def __init__(self) -> None:
        self.held = True
        # Whether a frame response took the slot over; the slot never refers to it, so it can be collected.
        self.taken = False

    def release(self) -> None:
        if self.held:
            self.held = False
            _VIEWS.release()


class _Frame(Response):
    """One frame Team built, holding its slot until the response ends however it ends; a slow page is cut off."""

    def __init__(self, contents: bytes, number: int, slot: _Slot) -> None:
        headers = {**_NO_STORE, view_contract.FRAME_HEADER: str(number)}
        super().__init__(content=contents, media_type="image/png", headers=headers)
        self._slot = slot
        slot.taken = True
        weakref.finalize(self, slot.release)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            with anyio.move_on_after(VIEW_SEND_SECONDS):
                await super().__call__(scope, receive, send)
        finally:
            self._slot.release()


async def browser_frame(team_id: str, view_id: str, after: str, request: Request) -> Response:
    """The watched task's next frame after `after`, no content when none came in time, or a closed refusal."""
    if not browser.same_origin_fetch(request, browser.IMAGE_DESTINATIONS):
        return JSONResponse(status_code=403, content={"detail": "browser origin is not admitted"}, headers=_NO_STORE)
    if not _VIEWS.acquire(blocking=False):
        busy = {"detail": "browser view unavailable", "code": view_contract.BUSY, "retry_after_ms": VIEW_RETRY_MS}
        return JSONResponse(status_code=503, content=busy, headers=_NO_STORE)
    slot = _Slot()
    try:
        with team_http.refused_as_bad_request():
            result = await run_in_threadpool(team.browser_view_frame, team_id, view_id, after)
        if result.status == 204:
            return Response(status_code=204, headers=_NO_STORE)
        if result.contents is None or result.frame is None:
            return JSONResponse(status_code=result.status, content=result.error, headers=_NO_STORE)
        return _Frame(result.contents, result.frame, slot)
    finally:
        # Only a frame response takes the slot over; every other outcome releases it here.
        if not slot.taken:
            slot.release()
