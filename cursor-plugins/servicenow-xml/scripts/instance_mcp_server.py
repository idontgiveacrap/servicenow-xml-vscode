#!/usr/bin/env python3
"""
Local-only MCP server for read-only ServiceNow instance queries via snc.

Installed by the servicenow-xml extension as MCP id servicenow-xml-instance
(managed-by: servicenow-xml).

Security/network model:
- Uses MCP stdio transport only.
- Does not open sockets, ports, or HTTP endpoints.
- Spawns the configured snc executable for profile list, record query, and
  record get. Does not wrap create/update/delete or other mutating commands.

Usage:
  set SNC_PATH=snc
  set SNC_PROFILE_ALLOWLIST=["pdi"]
  python scripts/instance_mcp_server.py
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp_usage_log import log_use

ANSI_RE = re.compile(r"\x1B\[[0-9;]*[A-Za-z]")
PROFILE_TIMEOUT_SEC = 120
QUERY_TIMEOUT_SEC = 300
DEFAULT_QUERY_LIMIT = 100
MAX_QUERY_LIMIT = 100
CREATE_NO_WINDOW = 0x08000000


def _snc_path() -> str:
    """Return the snc executable from SNC_PATH, or the name `snc` on PATH."""
    raw = os.environ.get("SNC_PATH", "").strip()
    return raw or "snc"


def _profile_allowlist() -> list[str] | None:
    """
    Parse SNC_PROFILE_ALLOWLIST as a JSON string array.

    Empty, unset, or [] means every snc profile is allowed.
    """
    raw = os.environ.get("SNC_PROFILE_ALLOWLIST", "").strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"SNC_PROFILE_ALLOWLIST is not valid JSON: {exc}") from exc
    if not isinstance(parsed, list):
        raise ValueError("SNC_PROFILE_ALLOWLIST must be a JSON array of profile names")
    names = [str(item).strip() for item in parsed if str(item).strip()]
    return names or None


def _parse_cli_json(stdout: str) -> Any:
    """
    Parse the JSON document out of snc stdout.

    snc writes spinner frames and an ANSI-colored status banner before the
    payload, so the raw stdout is never valid JSON.
    """
    cleaned = ANSI_RE.sub("", stdout)
    start = -1
    for index, char in enumerate(cleaned):
        if char in "[{":
            start = index
            break
    if start < 0:
        raise ValueError("no JSON payload in snc output")
    try:
        return json.loads(cleaned[start:].strip())
    except json.JSONDecodeError as exc:
        raise ValueError("snc JSON payload is not parseable") from exc


def _payload_error(parsed: Any) -> str | None:
    """Return an instance error message when snc exits 0 with a failure envelope."""
    if not isinstance(parsed, dict):
        return None
    error = parsed.get("error")
    if error is not None and error != "":
        if isinstance(error, dict):
            detail = error.get("message")
            if isinstance(detail, str) and detail.strip():
                return f"instance error: {detail.strip()}"
        elif isinstance(error, str) and error.strip():
            return f"instance error: {error.strip()}"
        return "instance returned an error payload"
    status = parsed.get("status")
    if status is not None and status != "success":
        return f"instance status {status}"
    return None


def _is_default_profile(name: str, row: dict[str, Any]) -> bool:
    """True when snc marks this row as default, or the profile is named default."""
    for key in ("default", "isDefault", "is_default"):
        value = row.get(key)
        if value is True or value == 1 or (
            isinstance(value, str) and value.strip().lower() in ("true", "1", "yes")
        ):
            return True
    return name == "default"


def _parse_profile_list(stdout: str) -> list[dict[str, Any]]:
    """Parse `snc configure profile list` into name/host/username/is_default rows."""
    parsed = _parse_cli_json(stdout)
    if not isinstance(parsed, dict) or isinstance(parsed, list):
        raise ValueError("unexpected snc profile list shape")
    out: list[dict[str, Any]] = []
    for name, value in parsed.items():
        if not name or not isinstance(value, dict) or isinstance(value, list):
            raise ValueError("unexpected snc profile list row")
        row = {
            "name": name,
            "is_default": _is_default_profile(name, value),
        }
        host = value.get("host")
        username = value.get("username")
        if isinstance(host, str) and host.strip():
            row["host"] = host.strip()
        if isinstance(username, str) and username.strip():
            row["username"] = username.strip()
        out.append(row)
    return out


def _run_snc(args: list[str], timeout: int) -> str:
    """
    Run snc with shared non-interactive JSON flags.

    Returns stdout. Raises ValueError on timeout, spawn failure, non-zero
    exit, or an instance error envelope in the payload.
    """
    argv = [_snc_path(), *args, "--no-interactive", "--no-verbose", "--output", "json"]
    kwargs: dict[str, Any] = {
        "capture_output": True,
        "text": True,
        "timeout": timeout,
        "encoding": "utf-8",
        "errors": "replace",
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = CREATE_NO_WINDOW
    try:
        completed = subprocess.run(argv, **kwargs)
    except FileNotFoundError as exc:
        raise ValueError(f"snc executable not found ({_snc_path()})") from exc
    except subprocess.TimeoutExpired as exc:
        raise ValueError(
            f"snc timed out after {timeout}s ({' '.join(args[:4])})"
        ) from exc
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    if completed.returncode != 0:
        detail = " ".join(part.strip() for part in (stderr, stdout) if part.strip())
        raise ValueError(detail or f"snc exited ({completed.returncode})")
    parsed = _parse_cli_json(stdout)
    payload_error = _payload_error(parsed)
    if payload_error:
        raise ValueError(payload_error)
    return stdout


def _load_profiles() -> list[dict[str, Any]]:
    """Load snc profiles and apply the optional allowlist."""
    stdout = _run_snc(["configure", "profile", "list"], PROFILE_TIMEOUT_SEC)
    profiles = _parse_profile_list(stdout)
    allow = _profile_allowlist()
    if allow is None:
        return profiles
    allowed = {name.lower() for name in allow}
    return [row for row in profiles if str(row["name"]).lower() in allowed]


def _resolve_profile_arg(profile: str) -> str | None:
    """
    Return the --profile value to pass to snc, or None to use the CLI default.

    When an allowlist is set, omit-profile is only allowed if the CLI default
    profile can be identified and is on the allowlist.
    """
    requested = profile.strip()
    allow = _profile_allowlist()
    if allow is None:
        return requested or None
    allowed = {name.lower() for name in allow}
    if requested:
        if requested.lower() not in allowed:
            raise ValueError(
                f"profile {requested!r} is not in servicenowXml.snc.mcpProfiles"
            )
        return requested
    profiles = _load_profiles()
    defaults = [row["name"] for row in profiles if row.get("is_default")]
    if len(defaults) != 1:
        raise ValueError(
            "CLI default profile is not on the mcpProfiles allowlist or could "
            "not be determined; pass profile explicitly"
        )
    return str(defaults[0])


def _query_limit(limit: int) -> int:
    """Clamp record_query limit to 1..MAX_QUERY_LIMIT."""
    try:
        value = int(limit)
    except (TypeError, ValueError):
        return DEFAULT_QUERY_LIMIT
    return max(1, min(value, MAX_QUERY_LIMIT))


def _build_server() -> FastMCP:
    mcp = FastMCP("servicenow-xml-instance")

    @mcp.tool()
    @log_use("servicenow-xml-instance")
    def list_profiles() -> list[dict[str, Any]]:
        """
        List snc connection profiles the instance MCP may use.

        Each row has name, optional host, optional username, and is_default.
        When servicenowXml.snc.mcpProfiles is a non-empty allowlist, only those
        names are returned. Unset or empty allowlist returns every snc profile.
        """
        return _load_profiles()

    @mcp.tool()
    @log_use("servicenow-xml-instance")
    def record_query(
        table: str,
        query: str = "",
        fields: str = "sys_id",
        limit: int = DEFAULT_QUERY_LIMIT,
        offset: int = 0,
        profile: str = "",
    ) -> str:
        """
        Read-only snc record query. Prefer repo and docs/schema MCP first.

        table: ServiceNow table name.
        query: encoded query (same as snc --query). Empty returns the first page.
        fields: comma-separated columns. Default sys_id. Always pass the columns
        you need; omitting this dumps whatever snc returns for those fields.
        limit: max rows, default 100, capped at 100.
        offset: starting index for pagination.
        profile: snc profile name. Empty uses the CLI default profile. When an
        allowlist is set, the default must be on that list or this fails.
        """
        table_name = table.strip()
        if not table_name:
            raise ValueError("table is required")
        field_list = fields.strip() or "sys_id"
        args = [
            "record",
            "query",
            "--table",
            table_name,
            "--fields",
            field_list,
            "--limit",
            str(_query_limit(limit)),
        ]
        encoded = query.strip()
        if encoded:
            args.extend(["--query", encoded])
        if offset and int(offset) > 0:
            args.extend(["--offset", str(int(offset))])
        resolved = _resolve_profile_arg(profile)
        if resolved:
            args.extend(["--profile", resolved])
        stdout = _run_snc(args, QUERY_TIMEOUT_SEC)
        parsed = _parse_cli_json(stdout)
        if isinstance(parsed, dict) and "result" in parsed:
            return json.dumps(parsed["result"], ensure_ascii=False)
        return json.dumps(parsed, ensure_ascii=False)

    @mcp.tool()
    @log_use("servicenow-xml-instance")
    def record_get(table: str, sys_id: str, profile: str = "") -> str:
        """
        Read-only snc record get by sys_id. Prefer repo source when exported.

        table: ServiceNow table name.
        sys_id: record sys_id.
        profile: snc profile name. Empty uses the CLI default profile. When an
        allowlist is set, the default must be on that list or this fails.
        """
        table_name = table.strip()
        record_id = sys_id.strip()
        if not table_name:
            raise ValueError("table is required")
        if not record_id:
            raise ValueError("sys_id is required")
        args = [
            "record",
            "get",
            "--table",
            table_name,
            "--sysid",
            record_id,
        ]
        resolved = _resolve_profile_arg(profile)
        if resolved:
            args.extend(["--profile", resolved])
        stdout = _run_snc(args, QUERY_TIMEOUT_SEC)
        parsed = _parse_cli_json(stdout)
        if isinstance(parsed, dict) and "result" in parsed:
            return json.dumps(parsed["result"], ensure_ascii=False)
        return json.dumps(parsed, ensure_ascii=False)

    return mcp


if __name__ == "__main__":
    server = _build_server()
    server.run()
