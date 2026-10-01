#!/usr/bin/env python3
"""
Cursor sessionStart hook for ServiceNow export workspaces.

Tells the agent to use the extension MCP servers. Does not regenerate index.json.

Installed by the servicenow-xml extension (managed-by: servicenow-xml).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

MARKER = "servicenow-xml"


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def _read_stdin() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def _looks_like_sn_export(root: Path) -> bool:
    """
    True when the workspace holds `{sys_id}/sys_app_{sys_id}.xml`
    one level below the root (same marker as the extension workspace gate).
    """
    try:
        for child in root.iterdir():
            if not child.is_dir():
                continue
            name = child.name
            if len(name) == 32 and all(c in "0123456789abcdef" for c in name.lower()):
                if (child / f"sys_app_{name}.xml").is_file():
                    return True
    except OSError:
        return False
    return False


def _registry_cache_exists(root: Path) -> bool:
    try:
        return (root / ".servicenow-xml" / "registry-cache.json").is_file()
    except OSError:
        return False


def main() -> int:
    payload = _read_stdin()
    roots = payload.get("workspace_roots") or []
    if not isinstance(roots, list):
        roots = []

    sn_roots: list[str] = []
    missing_cache: list[str] = []
    for raw in roots:
        if not isinstance(raw, str) or not raw.strip():
            continue
        root = Path(raw)
        if not _looks_like_sn_export(root):
            continue
        sn_roots.append(str(root))
        if not _registry_cache_exists(root):
            missing_cache.append(str(root))

    if not sn_roots:
        _emit({})
        return 0

    text = (
        f"[{MARKER}] This workspace is a ServiceNow scoped-app export. "
        "Use servicenow-xml-registry: search_records, lookup_by_name, and "
        "lookup_script_include for export rows; get_workspace_app for scope, "
        "jsLevel (ES5 or ES12), supportsES12 (true only when the scope is "
        "non-global and sys_app js_level is es_latest), and restrictTableAccess; "
        "list_tables, get_table, list_columns, and search_schema for one dictionary "
        "(platform pack plus project exports; project columns win); "
        "list_reference_issues for deleted sys_id targets; references_to and "
        "references_from for one record; lookup_scripting_name for platform API docs. "
        "Use servicenow-xml-instance for live list_profiles, record_query, and "
        "record_get. Use servicenow-xml-docs for product docs. "
        "Do not read or regenerate index.json."
    )
    if missing_cache:
        text += (
            " Registry cache is not on disk yet for: "
            + ", ".join(missing_cache)
            + ". The extension writes .servicenow-xml/registry-cache.json when it scans."
        )
    _emit({"additional_context": text})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
