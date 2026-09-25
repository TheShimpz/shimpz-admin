"""Emit content-free spans only in the disposable Admin benchmark process."""

from __future__ import annotations

import functools
import json
import os
import sys
import time
from pathlib import Path

if sys.argv and sys.argv[0].rsplit("/", 1)[-1] == "uvicorn" and os.environ.get("SHIMPZ_PERF_ADMIN_SPANS") == "1":
    sys.path.insert(0, str(Path.cwd()))
    from team import bridge as team

    from chat import local, store_catalog

    def _timed(stage, operation):
        @functools.wraps(operation)
        def wrapped(*args, **kwargs):
            started_epoch_ns = time.time_ns()
            started = time.monotonic_ns()
            succeeded = False
            try:
                result = operation(*args, **kwargs)
                succeeded = True
                return result
            finally:
                print(
                    "SHIMPZ-PERF-ADMIN-SPAN "
                    + json.dumps(
                        {
                            "stage": stage,
                            "start_epoch_ns": started_epoch_ns,
                            "start_mono_ns": started,
                            "elapsed_ns": time.monotonic_ns() - started,
                            "ok": succeeded,
                        }
                    ),
                    file=sys.stderr,
                    flush=True,
                )

        return wrapped

    store_catalog.CATALOG._loader = _timed("store-fetch", store_catalog.CATALOG._loader)
    store_catalog.StoreCatalog.get = _timed("store-get", store_catalog.StoreCatalog.get)
    local.intent_route = _timed("classification", local.intent_route)
    local.capability_plan = _timed("capability-plan", local.capability_plan)
    team.list_installed_assistants = _timed("installed-inventory", team.list_installed_assistants)
    team.list_local_assistants = _timed("local-catalog", team.list_local_assistants)
    print("SHIMPZ-PERF-ADMIN-INSTALLED", file=sys.stderr, flush=True)
