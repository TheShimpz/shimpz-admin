"""A fresh Admin ``app`` import over a private temporary Local Space, for suites that call routes directly."""

import asyncio
import contextlib
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest import mock


def temporary_root(case: type[unittest.TestCase]) -> Path:
    """Return a private directory removed when the test class finishes."""
    temporary = tempfile.TemporaryDirectory()
    case.addClassCleanup(temporary.cleanup)
    return Path(temporary.name)


def environment(root: Path, extra: dict[str, str] | None = None) -> dict[str, str]:
    """Return the Local Admin environment for a Space rooted at ``root``, plus any extra variables."""
    return {
        "SHIMPZ_REPO": str(root),
        "SHIMPZ_ADMIN_STORE": str(root / "admin.json"),
        **(extra or {}),
    }


def load_app(
    root: Path,
    *patches: contextlib.AbstractContextManager[object],
    extra: dict[str, str] | None = None,
) -> ModuleType:
    """Import ``app`` anew under that environment; the environment and the patches apply only while importing."""
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.dict(os.environ, environment(root, extra)))
        for patch in patches:
            stack.enter_context(patch)
        sys.modules.pop("app", None)
        return importlib.import_module("app")


def replace_for_class(case: type[unittest.TestCase], owner: object, name: str, value: object) -> None:
    """Set one module attribute for the whole test class and restore it when the class finishes."""
    previous = getattr(owner, name)
    setattr(owner, name, value)
    case.addClassCleanup(setattr, owner, name, previous)


def route_methods(admin_app: ModuleType) -> set[tuple[str, str]]:
    """Every (path, HTTP method) pair the imported Admin application registers."""
    return {
        (route.path, method) for route in admin_app.app.routes for method in (getattr(route, "methods", None) or set())
    }


class RouteStatusAssertions(unittest.TestCase):
    """Route suites that assert the HTTP status a refused route coroutine raises."""

    admin_app: ModuleType

    def assert_status(self, expected: int, awaitable) -> None:
        with self.assertRaises(self.admin_app.HTTPException) as raised:
            asyncio.run(awaitable)
        self.assertEqual(raised.exception.status_code, expected)
