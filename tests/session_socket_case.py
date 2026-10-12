"""The base case of the Admin session socket tests (ADR-0114): an app with fresh session budgets per test."""

from unittest import mock

from tests.chat_socket_case import ChatWebSocketCase

from tests import chat_socket_fixtures

Socket = chat_socket_fixtures.Socket


class SessionSocketCase(ChatWebSocketCase):
    def setUp(self) -> None:
        super().setUp()
        self.session_socket = __import__("session.socket", fromlist=["socket"])
        self.registry = __import__("session.registry", fromlist=["registry"])
        self.topics = __import__("session.topics", fromlist=["topics"])
        self.budget = __import__("session.budget", fromlist=["budget"])
        self.calls = __import__("session.calls", fromlist=["calls"])
        self.methods = __import__("session.methods", fromlist=["methods"])
        self.lane = __import__("session.lane", fromlist=["lane"])
        # The real watcher's first samples would announce their topics to any test that subscribes to them; a test of
        # the watcher installs its own.
        watcher = __import__("session.watcher", fromlist=["watcher"])
        quiet = mock.patch.object(watcher, "WATCHER", watcher.Watcher({}))
        quiet.start()
        self.addCleanup(quiet.stop)
        # Each test starts with fresh session budgets, so one test's opens and calls never spend another's.
        for name in ("OPENS", "CALL_BUDGET", "CHANGE_BUDGET"):
            patch = mock.patch.object(
                self.budget, name, type(getattr(self.budget, name))(getattr(self.budget, name)._limit)
            )
            patch.start()
            self.addCleanup(patch.stop)

    async def _connect(self, **options) -> Socket:
        websocket = Socket(self.admin_app.app, token=self.token, **options)
        self.assertTrue(self._accepted(await websocket.start()))
        return websocket

    @staticmethod
    async def _closed(websocket: Socket) -> int:
        """Read past the socket's frames to its close, returning the close code."""
        while (message := await websocket.next_message())["type"] != "websocket.close":
            pass
        return message["code"]

    @staticmethod
    def _refusal(code: int) -> dict:
        return {"type": "websocket.close", "code": code, "reason": ""}
