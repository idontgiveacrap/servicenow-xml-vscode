#!/usr/bin/env python3
"""
Local-only MCP server for ServiceNow sys_dictionary schema context.

Installed by the servicenow-xml extension as MCP id servicenow-xml-db-schema
(managed-by: servicenow-xml).

Security/network model:
- Uses MCP stdio transport only.
- Does not open sockets, ports, or HTTP endpoints.
- Reads only a configured local CSV (or .csv.gz) path.

Data source (refresh from an instance):
  /sys_dictionary_list.do?sysparm_query=sys_scope.scopeNOT+IN{custom scope names}^ORsys_scopeISEMPTY&CSV&sysparm_default_export_fields=all

Replace `{custom scope names}` with a comma-separated list of scoped app
scope values to exclude (e.g. x_prefix_app). The
`ORsys_scopeISEMPTY` clause keeps global / empty-scope dictionary rows.

Usage:
  set SCHEMA_CSV_PATH=C:/path/to/sys_dictionary.csv.gz
  python scripts/db_schema_mcp_server.py
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP


@dataclass
class FieldInfo:
    element: str
    data: dict[str, str]


@dataclass
class TableInfo:
    name: str
    collection: dict[str, str] = field(default_factory=dict)
    fields: dict[str, FieldInfo] = field(default_factory=dict)


def _truthy(raw: str | None) -> bool | None:
    if raw is None:
        return None
    value = raw.strip().lower()
    if value in ("true", "1", "yes"):
        return True
    if value in ("false", "0", "no"):
        return False
    return None


def _open_text(path: Path) -> io.TextIOBase:
    """Open CSV as text; support .gz and Windows cp1252 exports."""
    if path.suffix.lower() == ".gz" or path.name.lower().endswith(".csv.gz"):
        raw = gzip.open(path, "rb")
    else:
        raw = path.open("rb")
    # ServiceNow list CSV exports on Windows are typically cp1252.
    return io.TextIOWrapper(raw, encoding="cp1252", errors="replace", newline="")


class SchemaIndex:
    def __init__(self, csv_path: Path) -> None:
        self.csv_path = csv_path
        self.tables: dict[str, TableInfo] = {}
        self.row_count = 0
        self._load()

    def _load(self) -> None:
        with _open_text(self.csv_path) as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames:
                raise ValueError(f"CSV has no header row: {self.csv_path}")
            for row in reader:
                self.row_count += 1
                name = (row.get("name") or "").strip()
                if not name:
                    continue
                key = name.lower()
                table = self.tables.get(key)
                if table is None:
                    table = TableInfo(name=name)
                    self.tables[key] = table
                element = (row.get("element") or "").strip()
                if not element:
                    table.collection = {k: (row.get(k) or "") for k in row}
                    continue
                table.fields[element.lower()] = FieldInfo(
                    element=element,
                    data={k: (row.get(k) or "") for k in row},
                )

    def list_tables(self) -> list[str]:
        return sorted({info.name for info in self.tables.values()}, key=str.lower)

    def get_table(self, table_name: str) -> dict[str, Any] | None:
        info = self.tables.get(table_name.lower())
        if not info:
            return None
        fields: list[dict[str, Any]] = []
        for field in sorted(info.fields.values(), key=lambda f: f.element.lower()):
            fields.append(self._normalize_field(field.data, field.element))
        out: dict[str, Any] = {
            "table": info.name,
            "field_count": len(fields),
            "fields": fields,
        }
        if info.collection:
            label = (info.collection.get("column_label") or "").strip()
            if label:
                out["label"] = label
            internal = (info.collection.get("internal_type") or "").strip()
            if internal:
                out["internal_type"] = internal
        return out

    def list_columns(self, table_name: str) -> list[str] | None:
        info = self.tables.get(table_name.lower())
        if not info:
            return None
        return sorted((f.element for f in info.fields.values()), key=str.lower)

    def get_dictionary_rows(
        self, table_name: str, element: str | None = None
    ) -> list[dict[str, str]] | None:
        info = self.tables.get(table_name.lower())
        if not info:
            return None
        rows: list[dict[str, str]] = []
        if info.collection and not element:
            rows.append(dict(info.collection))
        if element:
            field = info.fields.get(element.lower())
            if field:
                rows.append(dict(field.data))
            return rows
        for field in sorted(info.fields.values(), key=lambda f: f.element.lower()):
            rows.append(dict(field.data))
        return rows

    def search(self, query: str, max_matches: int = 25) -> list[dict[str, Any]]:
        needle = query.strip().lower()
        if not needle:
            return []
        results: list[dict[str, Any]] = []
        for info in sorted(self.tables.values(), key=lambda t: t.name.lower()):
            hay_table = info.name.lower()
            if needle in hay_table:
                results.append(
                    {
                        "table": info.name,
                        "element": None,
                        "match": "table",
                        "label": (info.collection.get("column_label") or "").strip()
                        or None,
                    }
                )
                if len(results) >= max_matches:
                    return results
            for field in info.fields.values():
                blob = " ".join(
                    [
                        field.element,
                        field.data.get("column_label", ""),
                        field.data.get("internal_type", ""),
                        field.data.get("reference", ""),
                        field.data.get("attributes", ""),
                    ]
                ).lower()
                if needle in blob:
                    results.append(
                        {
                            "table": info.name,
                            "element": field.element,
                            "match": "field",
                            "label": (field.data.get("column_label") or "").strip()
                            or None,
                            "type": (field.data.get("internal_type") or "").strip()
                            or None,
                            "reference": (field.data.get("reference") or "").strip()
                            or None,
                        }
                    )
                    if len(results) >= max_matches:
                        return results
        return results

    @staticmethod
    def _normalize_field(row: dict[str, str], element: str) -> dict[str, Any]:
        out: dict[str, Any] = {"name": element}
        label = (row.get("column_label") or "").strip()
        if label:
            out["label"] = label
        type_name = (row.get("internal_type") or "").strip()
        if type_name:
            out["type"] = type_name
        reference = (row.get("reference") or "").strip()
        if reference:
            out["reference"] = reference
        max_length = (row.get("max_length") or "").strip()
        if max_length:
            out["max_length"] = max_length
        attributes = (row.get("attributes") or "").strip()
        if attributes:
            out["attributes"] = attributes
        choice = (row.get("choice") or "").strip()
        if choice:
            out["choice"] = choice
        default_value = (row.get("default_value") or "").strip()
        if default_value:
            out["default_value"] = default_value
        for key, out_key in (
            ("mandatory", "mandatory"),
            ("read_only", "read_only"),
            ("active", "active"),
            ("display", "display"),
            ("primary", "primary"),
        ):
            flag = _truthy(row.get(key))
            if flag is not None:
                out[out_key] = flag
        return out


def _get_schema_path() -> Path:
    raw = (
        os.environ.get("SCHEMA_CSV_PATH", "").strip()
        or os.environ.get("SCHEMA_XML_PATH", "").strip()
    )
    if not raw:
        raise ValueError("SCHEMA_CSV_PATH env var is required.")

    path = Path(raw).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"Schema CSV file not found: {path}")
    if not path.is_file():
        raise ValueError(f"SCHEMA_CSV_PATH is not a file: {path}")
    return path


def _safe_int(raw: Any, default: int, *, lo: int, hi: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(lo, min(value, hi))


def _build_server() -> FastMCP:
    schema_path = _get_schema_path()
    index = SchemaIndex(schema_path)

    mcp = FastMCP("servicenow-xml-db-schema")

    @mcp.resource("schema://meta")
    def schema_meta() -> str:
        return (
            f"path={schema_path}\n"
            f"size_bytes={schema_path.stat().st_size}\n"
            f"table_count={len(index.tables)}\n"
            f"row_count={index.row_count}\n"
            "format=sys_dictionary_csv\n"
            "source_url=/sys_dictionary_list.do?sysparm_query=sys_scope.scopeNOT+IN"
            "{custom scope names}^ORsys_scopeISEMPTY&CSV&sysparm_default_export_fields=all\n"
        )

    @mcp.resource("schema://tables")
    def schema_tables() -> str:
        return "\n".join(index.list_tables())

    @mcp.tool()
    def list_tables() -> list[str]:
        """List table names from the bundled sys_dictionary CSV."""
        return index.list_tables()

    @mcp.tool()
    def get_table(table_name: str) -> str:
        """
        Return normalized JSON for one table: label (if known) and field list
        with name, label, type, reference, flags.
        """
        data = index.get_table(table_name)
        if data is None:
            raise ValueError(f"Table not found: {table_name}")
        return json.dumps(data, ensure_ascii=False, indent=2)

    @mcp.tool()
    def list_columns(table_name: str) -> list[str]:
        """List field/element names for one table."""
        columns = index.list_columns(table_name)
        if columns is None:
            raise ValueError(f"Table not found: {table_name}")
        return columns

    @mcp.tool()
    def get_dictionary_rows(table_name: str, element: str = "") -> str:
        """
        Return original CSV row object(s) for a table (and optional element).
        Use when normalized get_table omits a column you need.
        """
        rows = index.get_dictionary_rows(
            table_name, element.strip() or None
        )
        if rows is None:
            raise ValueError(f"Table not found: {table_name}")
        return json.dumps(rows, ensure_ascii=False, indent=2)

    @mcp.tool()
    def search_schema(query: str, max_matches: int = 25) -> list[dict[str, Any]]:
        """Search table/field names and labels; return compact match objects."""
        limit = _safe_int(max_matches, 25, lo=1, hi=200)
        return index.search(query, max_matches=limit)

    return mcp


if __name__ == "__main__":
    server = _build_server()
    server.run()
