"""Append-only usage log for local servicenow-xml MCP tool calls."""

from __future__ import annotations

import functools
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, TypeVar

F = TypeVar("F", bound=Callable[..., object])

_DEFAULT_LOG = Path.home() / ".cursor" / "servicenow-xml" / "mcp-usage.log"


def log_mcp_use(server: str, tool: str) -> None:
    """
    Append one UTC line: timestamp server tool.

    Never raises; logging must not break tool handlers.
    """
    raw = os.environ.get("MCP_USAGE_LOG_PATH", "").strip()
    path = Path(raw).expanduser() if raw else _DEFAULT_LOG
    line = f"{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} {server} {tool}\n"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)
    except OSError:
        return


def log_use(server: str) -> Callable[[F], F]:
    """Decorator: record a tool call under `server` using the function name."""

    def deco(fn: F) -> F:
        @functools.wraps(fn)
        def wrapped(*args: object, **kwargs: object) -> object:
            log_mcp_use(server, fn.__name__)
            return fn(*args, **kwargs)

        return wrapped  # type: ignore[return-value]

    return deco
