#!/usr/bin/env python3
"""
Local-only MCP server for the bundled ServiceNow scripting / runtime reference.

Installed by the servicenow-xml extension as MCP id servicenow-xml-scripting
(managed-by: servicenow-xml).

Security/network model:
- Uses MCP stdio transport only.
- Does not open sockets, ports, or HTTP endpoints.
- Reads only a configured local JSON (or .json.gz) path.

Data source:
  Pack from the workbook with:
    python scripts/pack-scripting-reference.py path/to/workbook.xlsx

Usage:
  set SCRIPTING_REF_PATH=C:/path/to/scripting_reference.json.gz
  python scripts/scripting_mcp_server.py
"""

from __future__ import annotations

import gzip
import json
import os
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

SECTION_KEYS = (
    "runtime_catalog",
    "runtime_items",
    "server",
    "useful_scripts",
    "undocumented",
    "ui_builder",
    "documentation_workflow",
    "reference_sources",
)


def _open_bytes(path: Path) -> bytes:
    if path.suffix.lower() == ".gz" or path.name.lower().endswith(".json.gz"):
        with gzip.open(path, "rb") as handle:
            return handle.read()
    return path.read_bytes()


class ScriptingIndex:
    def __init__(self, path: Path) -> None:
        self.path = path
        raw = json.loads(_open_bytes(path).decode("utf-8"))
        if not isinstance(raw, dict):
            raise ValueError(f"Scripting reference root must be an object: {path}")
        self.data = raw

    def meta(self) -> dict[str, Any]:
        counts = self.data.get("counts") or {}
        return {
            "title": self.data.get("title"),
            "subtitle": self.data.get("subtitle"),
            "version": self.data.get("version"),
            "format": self.data.get("format"),
            "source_workbook": self.data.get("source_workbook"),
            "warnings": list(self.data.get("warnings") or []),
            "counts": counts,
            "sections": list(SECTION_KEYS),
            "path": str(self.path),
            "size_bytes": self.path.stat().st_size,
        }

    def get_section(self, section: str) -> Any:
        key = section.strip().lower().replace("-", "_").replace(" ", "_")
        aliases = {
            "catalog": "runtime_catalog",
            "runtime": "runtime_items",
            "items": "runtime_items",
            "scripts": "useful_scripts",
            "useful": "useful_scripts",
            "misc": "undocumented",
            "undocumented_apis": "undocumented",
            "uib": "ui_builder",
            "ui_builder_workspace": "ui_builder",
            "workflow": "documentation_workflow",
            "sources": "reference_sources",
        }
        key = aliases.get(key, key)
        if key not in SECTION_KEYS:
            raise ValueError(
                f"Unknown section {section!r}. Expected one of: {', '.join(SECTION_KEYS)}"
            )
        return self.data.get(key)

    def lookup_name(self, name: str) -> dict[str, Any]:
        needle = name.strip().lower()
        if not needle:
            raise ValueError("name is required")
        hits: dict[str, Any] = {"query": name, "server": None, "runtime_item": None}

        for row in self.data.get("server") or []:
            if str(row.get("name") or "").strip().lower() == needle:
                hits["server"] = row
                break

        for row in self.data.get("runtime_items") or []:
            if str(row.get("name") or "").strip().lower() == needle:
                hits["runtime_item"] = row
                break

        undocumented_hits = []
        for row in self.data.get("undocumented") or []:
            api = str(row.get("api") or "").strip().lower()
            members = str(row.get("members") or "").strip().lower()
            if needle == api or needle in members.split(",") or needle in members:
                undocumented_hits.append(row)
        hits["undocumented"] = undocumented_hits
        return hits

    def search(
        self,
        query: str,
        *,
        section: str | None = None,
        max_matches: int = 25,
    ) -> list[dict[str, Any]]:
        needle = query.strip().lower()
        if not needle:
            return []

        sections = [section] if section else list(SECTION_KEYS)
        # Normalize optional section filter through get_section for aliases.
        if section:
            # Validate / alias only; search walks concrete keys.
            resolved = section.strip().lower().replace("-", "_").replace(" ", "_")
            aliases = {
                "catalog": "runtime_catalog",
                "runtime": "runtime_items",
                "items": "runtime_items",
                "scripts": "useful_scripts",
                "useful": "useful_scripts",
                "misc": "undocumented",
                "uib": "ui_builder",
                "workflow": "documentation_workflow",
                "sources": "reference_sources",
            }
            sections = [aliases.get(resolved, resolved)]
            if sections[0] not in SECTION_KEYS:
                raise ValueError(
                    f"Unknown section {section!r}. Expected one of: {', '.join(SECTION_KEYS)}"
                )

        results: list[dict[str, Any]] = []
        for sec in sections:
            payload = self.data.get(sec)
            if sec == "runtime_catalog" and isinstance(payload, dict):
                for family in payload.get("families") or []:
                    blob = " ".join(str(v) for v in family.values()).lower()
                    if needle in blob:
                        results.append(
                            {
                                "section": sec,
                                "match": "family",
                                "pattern": family.get("pattern"),
                                "owner": family.get("owner"),
                                "classification": family.get("classification"),
                                "change_risk": family.get("change_risk"),
                            }
                        )
                        if len(results) >= max_matches:
                            return results
                continue

            if not isinstance(payload, list):
                continue
            for row in payload:
                if not isinstance(row, dict):
                    continue
                blob = " ".join(str(v) for v in row.values()).lower()
                if needle not in blob:
                    continue
                item: dict[str, Any] = {"section": sec, "match": "row"}
                for key in (
                    "name",
                    "api",
                    "pattern",
                    "tag",
                    "type",
                    "owner",
                    "family",
                    "runtime_layer",
                    "classification",
                    "supported_contract",
                    "change_risk",
                    "description",
                    "members",
                    "script",
                ):
                    if row.get(key):
                        item[key] = row[key]
                results.append(item)
                if len(results) >= max_matches:
                    return results
        return results


def _get_ref_path() -> Path:
    raw = os.environ.get("SCRIPTING_REF_PATH", "").strip()
    if not raw:
        raise ValueError("SCRIPTING_REF_PATH env var is required.")
    path = Path(raw).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"Scripting reference file not found: {path}")
    if not path.is_file():
        raise ValueError(f"SCRIPTING_REF_PATH is not a file: {path}")
    return path


def _safe_int(raw: Any, default: int, *, lo: int, hi: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(lo, min(value, hi))


def _build_server() -> FastMCP:
    ref_path = _get_ref_path()
    index = ScriptingIndex(ref_path)
    mcp = FastMCP("servicenow-xml-scripting")

    @mcp.resource("scripting://meta")
    def scripting_meta() -> str:
        return json.dumps(index.meta(), ensure_ascii=False, indent=2)

    @mcp.tool()
    def get_scripting_meta() -> str:
        """Return title, warnings, section list, and entry counts for the bundled scripting reference."""
        return json.dumps(index.meta(), ensure_ascii=False, indent=2)

    @mcp.tool()
    def list_scripting_sections() -> list[str]:
        """List available scripting-reference section ids."""
        return list(SECTION_KEYS)

    @mcp.tool()
    def get_scripting_section(section: str) -> str:
        """
        Return one full section as JSON.

        Sections: runtime_catalog, runtime_items, server, useful_scripts,
        undocumented, ui_builder, documentation_workflow, reference_sources
        (aliases: catalog, items, useful, misc, uib, workflow, sources).
        """
        data = index.get_section(section)
        return json.dumps(data, ensure_ascii=False, indent=2)

    @mcp.tool()
    def lookup_scripting_name(name: str) -> str:
        """Exact-name lookup across server globals, runtime items, and undocumented APIs."""
        return json.dumps(index.lookup_name(name), ensure_ascii=False, indent=2)

    @mcp.tool()
    def search_scripting_reference(
        query: str, section: str = "", max_matches: int = 25
    ) -> list[dict[str, Any]]:
        """
        Substring search across the scripting reference.

        Optional section limits the search (same ids/aliases as get_scripting_section).
        """
        limit = _safe_int(max_matches, 25, lo=1, hi=200)
        return index.search(
            query,
            section=section.strip() or None,
            max_matches=limit,
        )

    @mcp.tool()
    def list_runtime_items(
        owner: str = "",
        family: str = "",
        runtime_layer: str = "",
        query: str = "",
        max_matches: int = 50,
    ) -> list[dict[str, Any]]:
        """Filter browser-runtime items by owner, family, runtime_layer, and/or free-text query."""
        limit = _safe_int(max_matches, 50, lo=1, hi=500)
        owner_n = owner.strip().lower()
        family_n = family.strip().lower()
        layer_n = runtime_layer.strip().lower()
        query_n = query.strip().lower()
        out: list[dict[str, Any]] = []
        for row in index.data.get("runtime_items") or []:
            if owner_n and owner_n not in str(row.get("owner") or "").lower():
                continue
            if family_n and family_n not in str(row.get("family") or "").lower():
                continue
            if layer_n and layer_n not in str(row.get("runtime_layer") or "").lower():
                continue
            if query_n:
                blob = " ".join(str(v) for v in row.values()).lower()
                if query_n not in blob:
                    continue
            out.append(row)
            if len(out) >= limit:
                break
        return out

    return mcp


if __name__ == "__main__":
    server = _build_server()
    server.run()
