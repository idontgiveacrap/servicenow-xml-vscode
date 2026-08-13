#!/usr/bin/env python3
"""
Scan a ServiceNow scoped-application Git export and write split index files at the repo root.

Installed by the servicenow-xml extension (managed-by: servicenow-xml).

Typical layout: <repo>/<package_sys_id>/update/*.xml, author_elective_update/*.xml, sys_app_*.xml

Usage:
  python servicenow_repo_index.py [REPO_ROOT]
  python servicenow_repo_index.py [REPO_ROOT] --include-reference-warnings
  python servicenow_repo_index.py [REPO_ROOT] --include-reference-graph
  python servicenow_repo_index.py [REPO_ROOT] --all-records
  python servicenow_repo_index.py [REPO_ROOT] --no-reference-check

Default output (agent-ideal): minified split index with git HEAD commit id, slim canonical map,
lookup_by_name, reference_errors in index.json only; warnings/graph omitted unless opted in.

index.json `app` includes scope, js_level, supportsES12, version, short_description, and
restrict_table_access from the canonical sys_app export row.

Mechanical reference checks only scan **active** rows: each XML inner row is skipped when
`action="DELETE"` or when that row's `sys_id` is **logically deleted** in the union of the export.
Among duplicate active rows for the same sys_id, only the latest **sys_updated_on** is scanned for
outgoing references; others receive `duplicate_active_sys_id` warnings.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import re
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

SYS_ID_RE = re.compile(r"^[a-f0-9]{32}$", re.I)

# Element names whose 32-char text is usually not a Glide reference (reduce false positives).
SYS_ID_TEXT_IGNORE_TAGS = frozenset(
    {
        "sys_id",  # row identity; handled separately
        "source",  # sometimes update path / non-id
        "update_guid",
        "remote_sys_id",
        "remote_update_set",
        "sys_mod_count",
    }
)

# CDATA-heavy tables: only scan explicit *_id / known ref tags (avoid UUIDs inside embedded JS/XML).
SCRIPT_HEAVY_TABLES = frozenset(
    {
        "sys_script_include",
        "sys_script",
        "sys_script_client",
        "sys_ui_script",
        "sysauto_script",
        "sys_script_email",
        "sys_ux_client_script",
        "sys_ux_data_broker_scriptlet",
        "sys_ws_operation",
        "sys_rest_message_fn",
        "sys_ux_macroponent",
        "sys_hub_action_type_definition",
        "sys_ui_page",
        "sys_transform_script",
    }
)

# Skip UUID scan inside these element names (embedded code / markup).
SKIP_UUID_SCAN_TAGS = frozenset(
    {
        "script",
        "xml",
        "conditions",
        "query",
        "term",
        "annotation",
        "template",
        "operation_query",
        "calculation",
        "filter",
        "advanced",
        "client_transform_script",
        "client_script",
        "script_plain",
        "payload_template",
        "hint",
        "example",
    }
)

REF_LIKE_TAG_PREFIXES = ("sys_", "sn_", "m2m_", "par_", "sc_", "sp_", "x_")
REF_LIKE_TAG_SUFFIXES = ("_id", "_table", "_document", "_set", "_scope", "_application")

# Reference scan tuning
SCHEMA_VERSION = 7
REFERENCE_RULES_VERSION = 1
CANONICAL_CONVENTION = (
    "When a row's sys_id appears in the XML filename (e.g. update/sys_script_<sys_id>.xml), "
    "that path is canonical unless listed in index.canonical.json."
)
MAX_ISSUES_PER_RECORD = 20
MAX_REFERENCE_GRAPH_EDGES = 12000
MAX_INCOMING_REFS_PER_TARGET = 40
LOOKUP_FIELDS_ALLOWED = frozenset({"filename", "relative_path", "sys_id", "api_name", "category"})
DEFAULT_LOOKUP_TABLES = ("sys_script_include",)
DEFAULT_LOOKUP_FIELDS = ("filename",)

# Tags that must resolve inside this export (app integrity); missing target is always a warning.
ORPHAN_FOREIGN_TAGS = frozenset(
    {
        "list_id",
        "sys_ui_list",
        "sys_ui_section",
        "sys_ui_view",
        "sys_ui_form",
        "sys_ui_related_list",
        "sys_dictionary",
        "sys_db_object",
        "sys_documentation",
        "application",
        "flow",
        "sys_flow",
        "sys_template",
        "sys_email",
        "sys_script",
        "sys_script_include",
        "sys_choice",
        "sys_user",
        "sys_user_group",
        "sys_user_role",
        "sys_security_acl",
        "sys_transform_map",
        "sys_transform_entry",
        "sys_data_source",
        "sys_hub_flow",
        "sys_hub_action_type_definition",
        "sys_scope",
        "sys_package",
    }
)

# Explicit allowlist for non-script-heavy tables (in addition to *_id / heuristics).
GLIDE_REF_TAG_EXTRA = frozenset(
    {
        "sys_scope",
        "sys_package",
        "sys_store_application",
        "sys_app",
        "parent",
        "application",
        "flow",
        "sys_flow",
        "sys_template",
        "container_id",
        "consumer_id",
        "provider_id",
        "sys_hub_flow",
        "sys_hub_action_type_definition",
        "sys_ux_macroponent",
        "sys_ux_client_script",
        "sys_ux_data_broker",
        "sys_ux_screen",
        "sys_ux_app_config",
        "sys_ux_page_registry",
        "sys_ux_event",
        "sys_ws_definition",
        "sys_ws_operation",
        "sys_rest_message",
        "sys_rest_message_fn",
        "sys_properties",
        "sys_ui_action",
        "sys_ui_module",
        "sys_ui_element",
        "sys_ui_formatter",
        "sys_ui_policy",
        "sys_ui_page",
        "sys_metadata_link",
        "sys_rte_eb_entity_mapping",
        "sys_rte_eb_etl_definition",
        "sys_rte_eb_etl_field",
        "sys_rte_eb_etl_entity",
        "sys_security_acl",
        "sys_security_acl_role",
        "sys_user_role",
        "sys_user_role_contains",
        "sys_embedded_help_role",
        "sys_embedded_tour_guide",
        "sys_embedded_tour_step",
        "sys_declarative_action_assignment",
        "sys_declarative_action_payload_definition",
        "sys_hub_step_instance",
        "sys_hub_flow_logic",
        "par_dashboard",
        "par_dashboard_tab",
        "par_dashboard_widget",
        "assignment_group",
        "document_id",
        "target_id",
        "plugin_id",
        "sys_ux_addon_event_mapping",
        "sys_ux_applicability",
        "sys_ux_applicability_m2m_screen",
        "sys_ux_list",
        "sys_ux_list_category",
        "sys_ux_form_action",
        "sys_ux_controller",
        "sys_ux_client_script_include",
        "sys_ux_data_broker_transform",
        "sys_ux_data_broker_scriptlet",
        "sys_ux_screen_type",
        "sys_ux_app_route",
        "sys_ux_page_property",
        "sys_ux_registry_m2m_category",
        "sys_ux_ribbon_config",
        "sys_scope_privilege",
        "sys_restricted_caller_access",
        "sys_package_dependency_m2m",
        "sys_app_application",
        "sys_app_module",
        "sys_ui_application",
        "sys_ui_related",
        "sys_ui_list_element",
        "sys_ui_list_control",
        "sys_ui_policy_action",
        "sys_ui_policy_rl",
        "sys_ui_style",
        "sys_ui_list_layout",
        "sys_portal_page",
        "sys_portal",
        "sys_widget",
        "sp_page",
        "sp_widget",
        "sp_column",
        "sp_row",
        "sp_container",
        "m2m_sp_widget_dependency",
    }
)
GLIDE_REF_TAG_ALLOWLIST = frozenset(ORPHAN_FOREIGN_TAGS | GLIDE_REF_TAG_EXTRA)

# Element text that may be JSON with embedded sys_ids (non-script-heavy; --reference-embedded-json only).
EMBEDDED_JSON_SCAN_TAGS = frozenset(
    {
        "conditions",
        "query",
        "filter",
        "encoded_query",
        "advanced",
        "operation_query",
        "url",
        "parameters",
        "options",
        "schema",
        "property",
        "properties",
        "definition",
        "configuration",
        "metadata",
        "layout",
        "view_config",
    }
)


def _parse_sn_updated_ts(raw: str | None) -> float:
    if not raw:
        return 0.0
    s = raw.strip()
    if not s:
        return 0.0
    for slice_len, fmt in ((19, "%Y-%m-%d %H:%M:%S"), (10, "%Y-%m-%d")):
        if len(s) >= slice_len:
            try:
                return datetime.strptime(s[:slice_len], fmt).timestamp()
            except ValueError:
                continue
    return 0.0


def parse_xml_tree(path: Path) -> tuple[ET.ElementTree | None, str | None]:
    try:
        return ET.parse(path), None
    except ET.ParseError as e:
        return None, f"{path}: XML parse error: {e}"


def extract_records_from_tree(tree: ET.ElementTree, relative_path: str) -> tuple[list[dict], str | None]:
    records: list[dict] = []
    root = tree.getroot()
    targets: list[ET.Element] = []
    if _local_tag(root.tag) == "record_update":
        targets.append(root)
    else:
        for child in root:
            if isinstance(child, ET.Element) and _local_tag(child.tag) == "record_update":
                targets.append(child)

    if not targets:
        return [], f"{relative_path}: unexpected root tag {root.tag!r}"

    for elem in targets:
        table_attr = elem.get("table")
        children = [c for c in elem if isinstance(c, ET.Element)]
        for inner in children:
            table = table_attr or _local_tag(inner.tag)
            action = inner.get("action") or "INSERT_OR_UPDATE"
            sys_id = _text(inner.find("sys_id"))
            name = _text(inner.find("name"))
            api_name = _text(inner.find("api_name"))
            category = _text(inner.find("category"))
            sys_updated_on = _text(inner.find("sys_updated_on"))
            records.append(
                {
                    "table": table,
                    "sys_id": sys_id,
                    "action": action,
                    "name": name,
                    "api_name": api_name,
                    "category": category,
                    "sys_updated_on": sys_updated_on,
                    "relative_path": relative_path,
                }
            )

    return records, None


def parse_record_update_file(path: Path) -> tuple[list[dict], ET.ElementTree | None, str | None]:
    """Returns (records, tree_or_none, error_message)."""
    tree, err = parse_xml_tree(path)
    if err or tree is None:
        return [], None, err
    recs, err2 = extract_records_from_tree(tree, "")
    return recs, tree, err2


def compute_canonical_sources_and_duplicates(
    by_id: dict[str, list[dict]], deleted_ids: set[str]
) -> tuple[dict[str, str], list[dict]]:
    """Latest sys_updated_on among active rows wins; emit duplicate warnings for superseded files."""
    canonical: dict[str, str] = {}
    dup_issues: list[dict] = []
    for sid, evs in by_id.items():
        if not sid or sid in deleted_ids:
            continue
        active = [e for e in evs if e.get("action") != "DELETE" and e.get("sys_id")]
        if len(active) < 2:
            if len(active) == 1:
                p = str(active[0].get("relative_path") or "")
                if p:
                    canonical[sid] = p
            continue
        best = max(active, key=lambda e: _parse_sn_updated_ts(e.get("sys_updated_on")))
        best_path = str(best.get("relative_path") or "")
        canonical[sid] = best_path
        bu = best.get("sys_updated_on")
        for e in active:
            ep = str(e.get("relative_path") or "")
            if ep == best_path:
                continue
            dup_issues.append(
                _issue(
                    "warning",
                    "duplicate_active_sys_id",
                    f"sys_id {sid} appears in multiple active rows; canonical copy is {best_path} "
                    f"(latest sys_updated_on={bu!r}). This row is superseded.",
                    ep,
                    referencing_record_sys_id=sid,
                    canonical_relative_path=best_path,
                    canonical_sys_updated_on=bu,
                )
            )
    return canonical, dup_issues


def _is_canonical_row_for_scan(
    rel: str, record_sid: str | None, canonical_path_by_sid: dict[str, str] | None
) -> bool:
    if not record_sid or not canonical_path_by_sid:
        return True
    canon = canonical_path_by_sid.get(record_sid)
    if not canon:
        return True
    return rel == canon


def apply_max_issues_per_record(
    issues: list[dict], max_per: int = MAX_ISSUES_PER_RECORD
) -> tuple[list[dict], int]:
    counts: dict[tuple[str, str], int] = defaultdict(int)
    out: list[dict] = []
    suppressed = 0
    for it in issues:
        key = (
            str(it.get("relative_path") or ""),
            str(
                it.get("referencing_record_sys_id")
                or it.get("macroponent_sys_id")
                or "_"
            ),
        )
        if counts[key] >= max_per:
            suppressed += 1
            continue
        counts[key] += 1
        out.append(it)
    return out, suppressed


def _push_ref_edge(
    edges: list[dict],
    *,
    from_sid: str | None,
    from_table: str,
    rel: str,
    element_tag: str,
    to_sid: str,
) -> None:
    if not from_sid or len(edges) >= MAX_REFERENCE_GRAPH_EDGES:
        return
    t = to_sid.strip().lower()
    if not SYS_ID_RE.match(t):
        return
    edges.append(
        {
            "from_sys_id": from_sid,
            "from_table": from_table,
            "relative_path": rel,
            "element": element_tag,
            "to_sys_id": t,
        }
    )


def _collect_sys_ids_from_json_value(obj: object, out: set[str]) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(k, str):
                for m in SYS_ID_RE.finditer(k):
                    out.add(m.group().lower())
            _collect_sys_ids_from_json_value(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _collect_sys_ids_from_json_value(v, out)
    elif isinstance(obj, str):
        for m in SYS_ID_RE.finditer(obj):
            out.add(m.group().lower())


def _text(el: ET.Element | None) -> str | None:
    if el is None or el.text is None:
        return None
    t = el.text.strip()
    return t or None


def _supports_es12(scope: str | None, js_level: str | None) -> bool:
    """Scoped apps with js_level=es_latest run server scripts with ES2021 (Rhino ES12) semantics."""
    if not scope or scope.strip().lower() == "global":
        return False
    return (js_level or "").strip().lower() == "es_latest"


def _iter_record_update_inners(tree: ET.ElementTree) -> list[ET.Element]:
    root = tree.getroot()
    targets: list[ET.Element] = []
    if _local_tag(root.tag) == "record_update":
        targets.append(root)
    else:
        for child in root:
            if isinstance(child, ET.Element) and _local_tag(child.tag) == "record_update":
                targets.append(child)
    inners: list[ET.Element] = []
    for elem in targets:
        for inner in elem:
            if isinstance(inner, ET.Element):
                inners.append(inner)
    return inners


def extract_sys_app_metadata(
    parsed_trees: list[tuple[str, ET.ElementTree]],
    *,
    canonical_path_by_sid: dict[str, str] | None,
    deleted_ids: set[str],
) -> dict | None:
    """Read application-level metadata from the canonical active sys_app export row."""
    candidates: list[tuple[float, str, ET.Element]] = []
    for rel, tree in parsed_trees:
        for inner in _iter_record_update_inners(tree):
            if _local_tag(inner.tag) != "sys_app":
                continue
            if not _inner_record_is_active_for_reference_scan(inner, deleted_ids):
                continue
            app_sid = _text(inner.find("sys_id"))
            if not _is_canonical_row_for_scan(rel, app_sid, canonical_path_by_sid):
                continue
            candidates.append((_parse_sn_updated_ts(_text(inner.find("sys_updated_on"))), rel, inner))

    if not candidates:
        return None

    _, _, inner = max(candidates, key=lambda row: row[0])
    scope = _text(inner.find("scope"))
    js_level = _text(inner.find("js_level"))
    source = _text(inner.find("source"))
    restrict_raw = _text(inner.find("restrict_table_access"))
    restrict_table_access: bool | None
    if restrict_raw is None:
        restrict_table_access = None
    else:
        restrict_table_access = restrict_raw.strip().lower() == "true"

    app: dict[str, object] = {
        "sys_id": _text(inner.find("sys_id")),
        "name": _text(inner.find("name")),
        "scope": scope,
        "source": source or scope,
        "version": _text(inner.find("version")),
        "short_description": _text(inner.find("short_description")),
        "js_level": js_level,
        "supportsES12": _supports_es12(scope, js_level),
        "restrict_table_access": restrict_table_access,
    }
    return {k: v for k, v in app.items() if v is not None}


def _local_tag(tag: str) -> str:
    if "}" in tag:
        return tag.split("}", 1)[-1]
    return tag


def iter_export_xml_files(repo: Path) -> list[Path]:
    paths: list[Path] = []
    skip_dirs = {".git", "node_modules", ".cursor"}

    for p in repo.rglob("*.xml"):
        if skip_dirs & set(p.parts):
            continue
        s = p.as_posix().lower()
        if "/update/" in s or "/author_elective_update/" in s:
            paths.append(p)
            continue
        name = p.name.lower()
        if name.startswith("sys_app_") and name.endswith(".xml"):
            paths.append(p)

    return sorted(paths, key=lambda x: x.as_posix().lower())


def _export_dir_kind(relative_path: str) -> str:
    """Classify an export XML path as update, author_elective_update, or other."""
    s = relative_path.replace("\\", "/").lower()
    # author_elective_update before update — safer if path shape ever overlaps.
    if "/author_elective_update/" in s or s.startswith("author_elective_update/"):
        return "author_elective_update"
    if "/update/" in s or s.startswith("update/"):
        return "update"
    return "other"


# Full per-row lists are only included for these tables (and anything with --all-records).
DETAIL_TABLES = frozenset(
    {
        "sys_script_include",
        "sys_ui_action",
        "sys_ux_macroponent",
        "sys_ux_client_script",
        "sys_ux_page",
        "sys_ux_form_action",
        "sys_ux_screen_action",
        "sys_ux_form_action",
        "sys_ux_data_broker",
        "sys_ux_data_broker_scriptlet",
        "sys_ux_data_broker_rest",
        "sys_ux_controller",
        "sys_script_client",
        "sys_ui_script",
        "sys_script",
        "sysauto_script",
        "sys_script_email",
        "sys_ws_operation",
        "sys_rest_message_fn",
    }
)


def _issue(
    severity: str,
    issue_type: str,
    message: str,
    relative_path: str,
    **extra: object,
) -> dict:
    row: dict = {
        "severity": severity,
        "issue_type": issue_type,
        "message": message,
        "relative_path": relative_path,
    }
    row.update({k: v for k, v in extra.items() if v is not None})
    return row


def _extract_json_literal(node: object) -> str | int | float | bool | None:
    if not isinstance(node, dict):
        return None
    if node.get("type") != "JSON_LITERAL":
        return None
    return node.get("value")  # type: ignore[return-value]


def _walk_json(obj: object, visit) -> None:
    visit(obj)
    if isinstance(obj, dict):
        for v in obj.values():
            _walk_json(v, visit)
    elif isinstance(obj, list):
        for v in obj:
            _walk_json(v, visit)


def _macroponent_state_names(state_text: str) -> set[str]:
    names: set[str] = set()
    if not state_text or not state_text.strip():
        return names
    try:
        data = json.loads(state_text)
    except json.JSONDecodeError:
        return names
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                n = item.get("name")
                if isinstance(n, str):
                    names.add(n)
    return names


def _element_likely_glide_reference_field(tag: str) -> bool:
    t = tag.lower()
    if t in SYS_ID_TEXT_IGNORE_TAGS:
        return False
    if t.endswith("_id"):
        return True
    if any(t.startswith(p) for p in REF_LIKE_TAG_PREFIXES) and any(
        t.endswith(sfx) for sfx in REF_LIKE_TAG_SUFFIXES
    ):
        return True
    if t in ("sys_scope", "sys_package", "sys_app", "application", "parent", "flow", "sys_flow"):
        return True
    return False


def _should_scan_element_for_uuid_ref(table: str, tag: str) -> bool:
    tl = tag.lower()
    if tl in SKIP_UUID_SCAN_TAGS:
        return False
    if tl in SYS_ID_TEXT_IGNORE_TAGS:
        return False
    if table in SCRIPT_HEAVY_TABLES:
        return tl in GLIDE_REF_TAG_ALLOWLIST or _element_likely_glide_reference_field(tag)
    return tl.endswith("_id") or tl in GLIDE_REF_TAG_ALLOWLIST


def _state_binding_address(obj: dict) -> list[str] | None:
    """UXF sometimes puts address on the same dict as type; sometimes under obj['binding']."""
    addr = obj.get("address")
    if isinstance(addr, list) and addr:
        parts = [str(p) for p in addr if isinstance(p, str)]
        return parts or None
    b = obj.get("binding")
    if isinstance(b, dict):
        addr2 = b.get("address")
        if isinstance(addr2, list) and addr2:
            parts = [str(p) for p in addr2 if isinstance(p, str)]
            return parts or None
    return None


def _collect_state_bindings(obj: object, state_roots: set[str], out: list[tuple[str, str]]) -> None:
    """Collect (binding_dot_path, kind) where first segment is client state from state_properties."""

    def visit(o: object) -> None:
        if not isinstance(o, dict):
            return
        if o.get("type") != "STATE_BINDING":
            return
        parts = _state_binding_address(o)
        if not parts:
            return
        if len(parts) >= 1 and parts[0] in state_roots:
            out.append((".".join(parts), "STATE_BINDING"))

    _walk_json(obj, visit)


def _collect_data_output_bindings(obj: object, state_roots: set[str], out: list[tuple[str, str]]) -> None:
    def visit(o: object) -> None:
        if not isinstance(o, dict):
            return
        if o.get("type") != "DATA_OUTPUT_BINDING":
            return
        parts = _state_binding_address(o)
        if not parts:
            return
        if len(parts) >= 1 and parts[0] in state_roots:
            out.append((".".join(parts), "DATA_OUTPUT_BINDING"))

    _walk_json(obj, visit)


def _keys_from_state_value(val: object) -> set[str]:
    """Top-level keys merged into client state for one MACROPONENT_STATE_UPDATE_REQUESTED value."""
    keys: set[str] = set()
    if not isinstance(val, dict):
        return keys
    t = val.get("type")
    if t == "MAP_CONTAINER":
        cont = val.get("container")
        if isinstance(cont, dict):
            keys |= {str(k) for k in cont.keys()}
        return keys
    if t == "CLIENT_TRANSFORM" and val.get("operator") == "WITH":
        ops = val.get("operands")
        if isinstance(ops, dict):
            cont = ops.get("container")
            if isinstance(cont, list):
                literals: list[str] = []
                for item in cont:
                    if isinstance(item, dict) and item.get("type") == "JSON_LITERAL":
                        v = item.get("value")
                        if isinstance(v, str):
                            literals.append(v)
                # Common UXF pattern: [STATE_BINDING base, JSON_LITERAL key, JSON_LITERAL value, ...]
                if len(literals) >= 2:
                    keys.add(literals[0])
    return keys


def _collect_state_writers(obj: object, writers: dict[str, set[str]]) -> None:
    """Merge keys written per propName for sn_uxf.MACROPONENT_STATE_UPDATE_REQUESTED payloads."""

    def visit(o: object) -> None:
        if not isinstance(o, dict):
            return
        if o.get("apiName") != "sn_uxf.MACROPONENT_STATE_UPDATE_REQUESTED":
            return
        payloads: list[object] = []

        def grab_payloads(x: object) -> None:
            if isinstance(x, dict):
                if "payload" in x:
                    payloads.append(x["payload"])
                for v in x.values():
                    grab_payloads(v)
            elif isinstance(x, list):
                for v in x:
                    grab_payloads(v)

        grab_payloads(o)
        for pl in payloads:
            if not isinstance(pl, dict):
                continue
            c = pl.get("container")
            if not isinstance(c, dict):
                continue
            prop = _extract_json_literal(c.get("propName"))
            if not isinstance(prop, str):
                continue
            val = c.get("value")
            writers.setdefault(prop, set()).update(_keys_from_state_value(val))

    _walk_json(obj, visit)


def _collect_definition_ids(obj: object, out: set[str]) -> None:
    def visit(o: object) -> None:
        if not isinstance(o, dict):
            return
        if "definition" in o and isinstance(o["definition"], dict):
            did = o["definition"].get("id")
            if isinstance(did, str) and SYS_ID_RE.match(did):
                out.add(did)
        if "definitionId" in o and isinstance(o["definitionId"], str) and SYS_ID_RE.match(o["definitionId"]):
            out.add(o["definitionId"])

    _walk_json(obj, visit)


def _inner_record_is_active_for_reference_scan(inner: ET.Element, deleted_ids: set[str]) -> bool:
    """
    Reference and macroponent heuristics apply only to live export rows.

    Skip when the row is explicitly deleted in this file, or when its sys_id is
    logically deleted anywhere in the export (tombstone INSERT_OR_UPDATE).
    """
    if (inner.get("action") or "").upper() == "DELETE":
        return False
    sid = _text(inner.find("sys_id"))
    if sid and sid in deleted_ids:
        return False
    return True


def analyze_macroponent_tree(
    tree: ET.ElementTree,
    rel: str,
    *,
    canonical_path_by_sid: dict[str, str] | None,
    deleted_ids: set[str],
    all_ids: set[str],
    report_oob_definitions: bool,
) -> list[dict]:
    issues: list[dict] = []
    root = tree.getroot()
    targets: list[ET.Element] = []
    if _local_tag(root.tag) == "record_update":
        targets.append(root)
    else:
        for child in root:
            if isinstance(child, ET.Element) and _local_tag(child.tag) == "record_update":
                targets.append(child)

    for elem in targets:
        for inner in elem:
            if not isinstance(inner, ET.Element):
                continue
            if _local_tag(inner.tag) != "sys_ux_macroponent":
                continue
            if not _inner_record_is_active_for_reference_scan(inner, deleted_ids):
                continue
            mp_sid = _text(inner.find("sys_id"))
            if not _is_canonical_row_for_scan(rel, mp_sid, canonical_path_by_sid):
                continue
            comp_el = inner.find("composition")
            state_el = inner.find("state_properties")
            bundles_el = inner.find("bundles")
            comp_text = _text(comp_el) or ""
            state_text = _text(state_el) or ""
            bundles_text = _text(bundles_el) or ""

            blobs: list[object] = []
            for raw in (comp_text, bundles_text):
                if not raw.strip():
                    continue
                try:
                    blobs.append(json.loads(raw))
                except json.JSONDecodeError:
                    issues.append(
                        _issue(
                            "warning",
                            "macroponent_json",
                            "composition or bundles JSON could not be parsed",
                            rel,
                            macroponent_sys_id=mp_sid,
                        )
                    )

            state_names = _macroponent_state_names(state_text)
            if not state_names and state_text.strip():
                try:
                    json.loads(state_text)
                except json.JSONDecodeError:
                    pass
                else:
                    issues.append(
                        _issue(
                            "warning",
                            "macroponent_json",
                            "state_properties JSON parsed but no state keys found",
                            rel,
                            macroponent_sys_id=mp_sid,
                        )
                    )

            bindings: list[tuple[str, str]] = []
            writers: dict[str, set[str]] = defaultdict(set)
            def_ids: set[str] = set()

            for blob in blobs:
                _collect_state_bindings(blob, state_names, bindings)
                _collect_data_output_bindings(blob, state_names, bindings)
                _collect_state_writers(blob, writers)
                _collect_definition_ids(blob, def_ids)

            # Definition / bundle id targets
            for did in sorted(def_ids):
                if did in deleted_ids:
                    issues.append(
                        _issue(
                            "error",
                            "macroponent_definition_id",
                            f"composition/bundle references definition id that is logically deleted in this export: {did}",
                            rel,
                            referenced_sys_id=did,
                            macroponent_sys_id=mp_sid,
                        )
                    )
                elif did not in all_ids:
                    if not report_oob_definitions:
                        continue
                    issues.append(
                        _issue(
                            "warning",
                            "macroponent_definition_id",
                            f"composition/bundle references definition id not present in this export: {did}",
                            rel,
                            referenced_sys_id=did,
                            macroponent_sys_id=mp_sid,
                        )
                    )

            # STATE_BINDING / DATA_OUTPUT_BINDING leaf keys vs MAP_CONTAINER / WITH writers
            for bpath, bkind in bindings:
                parts = bpath.split(".")
                if len(parts) < 2:
                    continue
                root_name, leaf = parts[0], parts[-1]
                written = writers.get(root_name, set())
                if leaf in written:
                    continue
                # No MAP_CONTAINER / WITH keys extracted for this state prop — skip (client script / other transforms).
                if not written:
                    continue
                issues.append(
                    _issue(
                        "warning",
                        "macroponent_state_binding",
                        f"{bkind} path {bpath!r} is never written by any "
                        f"MACROPONENT_STATE_UPDATE_REQUESTED for prop {root_name!r} in this macroponent "
                        f"(missing literal MAP_CONTAINER key or WITH merge key).",
                        rel,
                        binding_path=bpath,
                        binding_kind=bkind,
                        state_property=root_name,
                        macroponent_sys_id=mp_sid,
                    )
                )

    return issues


def _emit_reference_target(
    issues: list[dict],
    ref_edges: list[dict],
    *,
    rel: str,
    table: str,
    record_sid: str | None,
    element_tag: str,
    target_sid: str,
    deleted_ids: set[str],
    all_ids: set[str],
    report_external: bool,
) -> None:
    tnorm = target_sid.strip().lower()
    if not SYS_ID_RE.match(tnorm) or (record_sid and tnorm == record_sid.strip().lower()):
        return
    base_tag = element_tag.lower().split(":", 1)[0]
    _push_ref_edge(
        ref_edges,
        from_sid=record_sid,
        from_table=table,
        rel=rel,
        element_tag=element_tag,
        to_sid=tnorm,
    )
    if tnorm in deleted_ids:
        issues.append(
            _issue(
                "error",
                "xml_reference_deleted",
                f"Element <{element_tag}> references sys_id {tnorm} which is logically deleted in this export.",
                rel,
                referenced_sys_id=tnorm,
                referencing_table=table,
                referencing_record_sys_id=record_sid,
            )
        )
        return
    if tnorm not in all_ids:
        if base_tag in ORPHAN_FOREIGN_TAGS:
            issues.append(
                _issue(
                    "warning",
                    "orphan_missing_target",
                    f"Element <{element_tag}> references sys_id {tnorm} which does not appear in this export "
                    f"(expected foreign key / related row).",
                    rel,
                    referenced_sys_id=tnorm,
                    referencing_table=table,
                    referencing_record_sys_id=record_sid,
                )
            )
        elif report_external:
            issues.append(
                _issue(
                    "warning",
                    "xml_reference_not_in_export",
                    f"Element <{element_tag}> references sys_id {tnorm} which does not appear in this export.",
                    rel,
                    referenced_sys_id=tnorm,
                    referencing_table=table,
                    referencing_record_sys_id=record_sid,
                )
            )


def _analyze_sys_scope(
    inner: ET.Element,
    table: str,
    rel: str,
    record_sid: str | None,
    deleted_ids: set[str],
    all_ids: set[str],
    report_external: bool,
    issues: list[dict],
    ref_edges: list[dict],
) -> None:
    scope_el = inner.find("sys_scope")
    if scope_el is None:
        return
    raw = _text(scope_el)
    if raw is None or raw == "":
        issues.append(
            _issue(
                "warning",
                "sys_scope_empty",
                "Element <sys_scope> is present but empty (scoped row should reference the application scope).",
                rel,
                referencing_table=table,
                referencing_record_sys_id=record_sid,
            )
        )
        return
    if not SYS_ID_RE.match(raw.strip()):
        issues.append(
            _issue(
                "warning",
                "sys_scope_non_sys_id",
                f"Element <sys_scope> text {raw!r} is not a 32-char sys_id.",
                rel,
                referencing_table=table,
                referencing_record_sys_id=record_sid,
            )
        )
        return
    _emit_reference_target(
        issues,
        ref_edges,
        rel=rel,
        table=table,
        record_sid=record_sid,
        element_tag="sys_scope",
        target_sid=raw,
        deleted_ids=deleted_ids,
        all_ids=all_ids,
        report_external=report_external,
    )


def analyze_xml_tree_reference_pass(
    tree: ET.ElementTree,
    rel: str,
    *,
    canonical_path_by_sid: dict[str, str] | None,
    deleted_ids: set[str],
    all_ids: set[str],
    report_external: bool,
    reference_embedded_json: bool,
    ref_edges: list[dict],
) -> list[dict]:
    """XML refs, sys_scope, embedded JSON sys_ids (optional), and graph edges — canonical active rows only."""
    issues: list[dict] = []
    root = tree.getroot()
    targets: list[ET.Element] = []
    if _local_tag(root.tag) == "record_update":
        targets.append(root)
    else:
        for child in root:
            if isinstance(child, ET.Element) and _local_tag(child.tag) == "record_update":
                targets.append(child)

    for elem in targets:
        for inner in elem:
            if not isinstance(inner, ET.Element):
                continue
            if not _inner_record_is_active_for_reference_scan(inner, deleted_ids):
                continue
            record_sid = _text(inner.find("sys_id"))
            table = _local_tag(inner.tag)
            if not _is_canonical_row_for_scan(rel, record_sid, canonical_path_by_sid):
                continue
            _analyze_sys_scope(
                inner, table, rel, record_sid, deleted_ids, all_ids, report_external, issues, ref_edges
            )
            for el in inner.iter():
                if not isinstance(el, ET.Element):
                    continue
                tag = _local_tag(el.tag)
                if tag in SYS_ID_TEXT_IGNORE_TAGS:
                    continue
                tl = tag.lower()
                scan_embedded = (
                    reference_embedded_json
                    and table not in SCRIPT_HEAVY_TABLES
                    and tl in EMBEDDED_JSON_SCAN_TAGS
                )
                scan_scalar = _should_scan_element_for_uuid_ref(table, tag)
                if not scan_embedded and not scan_scalar:
                    continue
                t = _text(el)
                if scan_embedded and t:
                    s = t.strip()
                    if s.startswith("{") or s.startswith("["):
                        try:
                            parsed: Any = json.loads(s)
                        except json.JSONDecodeError:
                            parsed = None
                        if parsed is not None:
                            jids: set[str] = set()
                            _collect_sys_ids_from_json_value(parsed, jids)
                            for jid in jids:
                                _emit_reference_target(
                                    issues,
                                    ref_edges,
                                    rel=rel,
                                    table=table,
                                    record_sid=record_sid,
                                    element_tag=f"{tag}:json",
                                    target_sid=jid,
                                    deleted_ids=deleted_ids,
                                    all_ids=all_ids,
                                    report_external=report_external,
                                )
                if not scan_scalar or not t or not SYS_ID_RE.match(t.strip()):
                    continue
                _emit_reference_target(
                    issues,
                    ref_edges,
                    rel=rel,
                    table=table,
                    record_sid=record_sid,
                    element_tag=tag,
                    target_sid=t,
                    deleted_ids=deleted_ids,
                    all_ids=all_ids,
                    report_external=report_external,
                )
    return issues


def build_reference_graph(edges: list[dict]) -> tuple[dict, dict]:
    referenced_by: dict[str, list[dict]] = defaultdict(list)
    for e in edges:
        tid = e["to_sys_id"]
        if len(referenced_by[tid]) >= MAX_INCOMING_REFS_PER_TARGET:
            continue
        referenced_by[tid].append(
            {
                "from_sys_id": e["from_sys_id"],
                "from_table": e["from_table"],
                "relative_path": e["relative_path"],
                "element": e["element"],
            }
        )
    summary = {
        "edge_count": len(edges),
        "targets_with_incoming": len(referenced_by),
    }
    return {"referenced_by": dict(sorted(referenced_by.items()))}, summary


def run_reference_checks(
    parsed_trees: list[tuple[str, ET.ElementTree]],
    *,
    canonical_path_by_sid: dict[str, str],
    deleted_ids: set[str],
    all_ids: set[str],
    report_external_refs: bool,
    report_oob_definitions: bool,
    reference_embedded_json: bool,
) -> tuple[list[dict], list[dict]]:
    issues: list[dict] = []
    ref_edges: list[dict] = []
    for rel, tree in parsed_trees:
        name = Path(rel).name.lower()
        if name.startswith("sys_ux_macroponent"):
            issues.extend(
                analyze_macroponent_tree(
                    tree,
                    rel,
                    canonical_path_by_sid=canonical_path_by_sid,
                    deleted_ids=deleted_ids,
                    all_ids=all_ids,
                    report_oob_definitions=report_oob_definitions,
                )
            )
        issues.extend(
            analyze_xml_tree_reference_pass(
                tree,
                rel,
                canonical_path_by_sid=canonical_path_by_sid,
                deleted_ids=deleted_ids,
                all_ids=all_ids,
                report_external=report_external_refs,
                reference_embedded_json=reference_embedded_json,
                ref_edges=ref_edges,
            )
        )
    return issues, ref_edges


def summarize_reference_issues(issues: list[dict]) -> dict:
    by_sev: dict[str, int] = defaultdict(int)
    by_type: dict[str, int] = defaultdict(int)
    for it in issues:
        by_sev[str(it.get("severity", "unknown"))] += 1
        by_type[str(it.get("issue_type", "unknown"))] += 1
    return {
        "total": len(issues),
        "by_severity": dict(sorted(by_sev.items())),
        "by_issue_type": dict(sorted(by_type.items(), key=lambda kv: (-kv[1], kv[0]))),
    }


def resolve_git_commit(repo_root: Path) -> dict[str, str | None]:
    """Current HEAD of the repo (active branch tip when run from a normal checkout)."""
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if proc.returncode == 0:
            full = proc.stdout.strip()
            if full:
                return {"git_commit": full, "git_commit_short": full[:7]}
    except (OSError, subprocess.TimeoutExpired):
        pass
    return {"git_commit": None, "git_commit_short": None}


def _sys_id_in_filename(sys_id: str, relative_path: str) -> bool:
    return sys_id in Path(relative_path).name


def build_slim_canonical(canonical_path_by_sid: dict[str, str]) -> dict[str, Any]:
    by_file: dict[str, list[str]] = defaultdict(list)
    for sid, path in canonical_path_by_sid.items():
        by_file[path].append(sid)
    multi_record_files = {
        p: sorted(sids) for p, sids in sorted(by_file.items()) if len(sids) > 1
    }
    in_multi_file: set[str] = set()
    for sids in multi_record_files.values():
        in_multi_file.update(sids)
    canonical_exceptions = {
        sid: path
        for sid, path in sorted(canonical_path_by_sid.items())
        if sid not in in_multi_file and not _sys_id_in_filename(sid, path)
    }
    return {
        "canonical_convention": CANONICAL_CONVENTION,
        "canonical_exceptions": canonical_exceptions,
        "multi_record_files": multi_record_files,
        "exception_count": len(canonical_exceptions),
        "multi_record_file_count": len(multi_record_files),
    }


def build_lookup_by_name(
    all_records: list[dict], canonical_path_by_sid: dict[str, str]
) -> dict[str, dict]:
    """
    Map `{table}.{name}` to the canonical (or newest) active row for DETAIL_TABLES.
    Uses the same canonical-path + sys_updated_on rules as compact lookup shards.
    """
    lookup: dict[str, dict] = {}
    for table in sorted(DETAIL_TABLES):
        chosen = _dedupe_lookup_records_by_name(
            all_records, canonical_path_by_sid, table
        )
        for name, record in chosen.items():
            key = f"{table}.{name}"
            lookup[key] = {
                "sys_id": record.get("sys_id"),
                "table": table,
                "relative_path": record.get("relative_path"),
                "api_name": record.get("api_name"),
            }
    return dict(sorted(lookup.items()))


def _lookup_filename_for_table(table: str) -> str:
    if table == "sys_script_include":
        return "index.script_includes.json"
    if table == "sys_ux_macroponent":
        return "index.macroponents.json"
    return f"index.lookup.{table}.json"


def _dedupe_lookup_records_by_name(
    all_records: list[dict], canonical_path_by_sid: dict[str, str], table: str
) -> dict[str, dict]:
    chosen_by_name: dict[str, dict] = {}
    for record in all_records:
        if record.get("action") == "DELETE" or record.get("logically_deleted"):
            continue
        if record.get("table") != table:
            continue
        script_name = record.get("name")
        record_sys_id = record.get("sys_id")
        relative_path = record.get("relative_path")
        if not script_name or not record_sys_id or not relative_path:
            continue

        canonical_path = canonical_path_by_sid.get(record_sys_id)
        if canonical_path and canonical_path != relative_path:
            continue

        existing = chosen_by_name.get(script_name)
        if existing is None:
            chosen_by_name[script_name] = record
            continue

        existing_ts = _parse_sn_updated_ts(existing.get("sys_updated_on"))
        candidate_ts = _parse_sn_updated_ts(record.get("sys_updated_on"))
        if candidate_ts > existing_ts:
            chosen_by_name[script_name] = record
    return chosen_by_name


def _lookup_row_payload(row: dict, lookup_fields: set[str]) -> str | dict[str, str]:
    if lookup_fields == {"filename"}:
        return Path(str(row["relative_path"])).name
    payload: dict[str, str] = {}
    if "filename" in lookup_fields:
        payload["filename"] = Path(str(row["relative_path"])).name
    if "relative_path" in lookup_fields:
        payload["relative_path"] = str(row["relative_path"])
    if "sys_id" in lookup_fields:
        payload["sys_id"] = str(row["sys_id"])
    if "api_name" in lookup_fields and row.get("api_name"):
        payload["api_name"] = str(row["api_name"])
    if "category" in lookup_fields and row.get("category"):
        payload["category"] = str(row["category"])
    return payload


def build_table_name_lookup(
    all_records: list[dict],
    canonical_path_by_sid: dict[str, str],
    *,
    table: str,
    lookup_fields: set[str],
) -> dict[str, str | dict[str, str]]:
    chosen_by_name = _dedupe_lookup_records_by_name(all_records, canonical_path_by_sid, table)
    return {
        script_name: _lookup_row_payload(row, lookup_fields)
        for script_name, row in sorted(chosen_by_name.items(), key=lambda item: item[0])
    }


def _parse_csv_flag(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def dedupe_reference_issues(issues: list[dict]) -> list[dict]:
    """Collapse identical findings; keep occurrence_count on the retained row."""
    merged: dict[tuple, dict] = {}
    for it in issues:
        key = (
            str(it.get("severity", "")),
            str(it.get("issue_type", "")),
            str(it.get("relative_path", "")),
            str(it.get("referenced_sys_id", "")),
            str(it.get("referencing_record_sys_id", "")),
            str(it.get("macroponent_sys_id", "")),
            str(it.get("message", "")),
        )
        if key in merged:
            merged[key]["occurrence_count"] = int(merged[key].get("occurrence_count", 1)) + 1
        else:
            row = dict(it)
            row["occurrence_count"] = 1
            merged[key] = row
    return sorted(
        merged.values(),
        key=lambda x: (
            x.get("severity", ""),
            x.get("issue_type", ""),
            x.get("relative_path", ""),
        ),
    )


def _json_dump(data: object, *, minify: bool) -> str:
    if minify:
        return json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    return json.dumps(data, indent=2, ensure_ascii=False)


def _atomic_write_text(path: Path, text: str) -> None:
    """Write text via a temp file + os.replace so readers never see a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp_path, path)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def write_index_outputs(
    repo_root: Path,
    *,
    meta: dict,
    canonical_body: dict,
    reference_issues: list[dict],
    reference_graph: dict,
    reference_graph_summary: dict,
    include_reference_warnings: bool,
    include_reference_graph: bool,
    full_canonical: bool,
    lookup_mode: str,
    table_name_lookups: dict[str, dict[str, str | dict[str, str]]],
    lookup_fields: list[str],
    minify: bool,
) -> tuple[list[str], dict[str, dict[str, int | float]]]:
    written: list[str] = []
    git = {k: meta[k] for k in ("git_commit", "git_commit_short") if k in meta}

    canon_path = repo_root / "index.canonical.json"
    canon_out = {
        "schema_version": SCHEMA_VERSION,
        **git,
        **canonical_body,
    }
    if full_canonical:
        full_map = meta.pop("_canonical_source_path_by_sys_id", {})
        canon_out["canonical_source_path_by_sys_id"] = full_map
    else:
        meta.pop("_canonical_source_path_by_sys_id", None)
    _atomic_write_text(canon_path, _json_dump(canon_out, minify=minify))
    written.append(canon_path.name)

    files: dict[str, str | dict[str, str] | None] = {
        "canonical": "index.canonical.json",
        "issues": None,
        "graph": None,
        "lookup_shards": {},
    }

    if include_reference_warnings:
        issues_path = repo_root / "index.issues.json"
        issues_out = {
            "schema_version": SCHEMA_VERSION,
            **git,
            "reference_issues": dedupe_reference_issues(reference_issues),
            "reference_issue_summary": meta.get("reference_issue_summary"),
        }
        _atomic_write_text(issues_path, _json_dump(issues_out, minify=minify))
        written.append(issues_path.name)
        files["issues"] = "index.issues.json"
    else:
        stale_issues = repo_root / "index.issues.json"
        if stale_issues.is_file():
            stale_issues.unlink()

    if include_reference_graph:
        graph_path = repo_root / "index.graph.json"
        graph_out = {
            "schema_version": SCHEMA_VERSION,
            **git,
            "reference_graph": reference_graph,
            "reference_graph_summary": reference_graph_summary,
        }
        _atomic_write_text(graph_path, _json_dump(graph_out, minify=minify))
        written.append(graph_path.name)
        files["graph"] = "index.graph.json"
    else:
        stale_graph = repo_root / "index.graph.json"
        if stale_graph.is_file():
            stale_graph.unlink()

    if lookup_mode == "compact":
        for table, lookup_map in sorted(table_name_lookups.items()):
            shard_name = _lookup_filename_for_table(table)
            shard_path = repo_root / shard_name
            shard_out = {
                "schema_version": SCHEMA_VERSION,
                **git,
                "table": table,
                "lookup_fields": lookup_fields,
                "name_lookup": lookup_map,
            }
            _atomic_write_text(shard_path, _json_dump(shard_out, minify=minify))
            written.append(shard_name)
            files["lookup_shards"][table] = shard_name  # type: ignore[index]
    else:
        meta["lookup_by_table_name"] = table_name_lookups

    meta["files"] = files
    # Manifest last so readers that check index.json first see a complete sibling set.
    meta_path = repo_root / "index.json"
    _atomic_write_text(meta_path, _json_dump(meta, minify=minify))
    written.insert(0, meta_path.name)
    size_report: dict[str, dict[str, int | float]] = {}
    for name in written:
        p = repo_root / name
        if not p.is_file():
            continue
        b = p.stat().st_size
        size_report[name] = {"bytes": b, "est_tokens": round(b / 4.0, 1)}
    return written, size_report


def build_index(
    repo_root: Path,
    *,
    embed_full_records: bool,
    reference_check: bool,
    report_external_refs: bool,
    report_oob_definitions: bool,
    reference_embedded_json: bool,
    include_reference_warnings: bool,
    include_reference_graph: bool,
    lookup_tables: list[str],
    lookup_fields: list[str],
    lookup_mode: str,
) -> dict:
    repo_root = repo_root.resolve()
    xml_files = iter_export_xml_files(repo_root)
    all_records: list[dict] = []
    errors: list[str] = []
    parsed_trees: list[tuple[str, ET.ElementTree]] = []

    for xf in xml_files:
        try:
            rel = xf.relative_to(repo_root).as_posix()
        except ValueError:
            rel = xf.as_posix()
        tree, terr = parse_xml_tree(xf)
        if terr:
            errors.append(terr)
            continue
        recs, err2 = extract_records_from_tree(tree, rel)
        if err2:
            errors.append(err2)
            continue
        all_records.extend(recs)
        parsed_trees.append((rel, tree))

    by_id: dict[str, list[dict]] = defaultdict(list)
    for r in all_records:
        sid = r.get("sys_id")
        if sid:
            by_id[sid].append(r)

    deleted_ids: set[str] = set()
    for sid, evs in by_id.items():
        if any(e.get("action") == "DELETE" for e in evs):
            deleted_ids.add(sid)

    for r in all_records:
        sid = r.get("sys_id")
        r["logically_deleted"] = bool(sid and sid in deleted_ids)

    counts_by_table: dict[str, int] = defaultdict(int)
    for r in all_records:
        if r.get("action") != "DELETE":
            counts_by_table[r.get("table") or "unknown"] += 1

    active_ids = {
        r["sys_id"] for r in all_records if r.get("sys_id") and r["sys_id"] not in deleted_ids
    }
    all_ids = {r["sys_id"] for r in all_records if r.get("sys_id")}

    detail_by_table: dict[str, list[dict]] = defaultdict(list)
    if not embed_full_records:
        for r in all_records:
            t = r.get("table") or "unknown"
            if t in DETAIL_TABLES:
                detail_by_table[t].append(
                    {
                        "sys_id": r.get("sys_id"),
                        "name": r.get("name"),
                        "api_name": r.get("api_name"),
                        "action": r.get("action"),
                        "logically_deleted": r.get("logically_deleted"),
                        "sys_updated_on": r.get("sys_updated_on"),
                        "relative_path": r.get("relative_path"),
                    }
                )

    canonical_path_by_sid, duplicate_issues = compute_canonical_sources_and_duplicates(by_id, deleted_ids)
    app = extract_sys_app_metadata(
        parsed_trees,
        canonical_path_by_sid=canonical_path_by_sid,
        deleted_ids=deleted_ids,
    )

    reference_issues: list[dict] = []
    reference_graph: dict[str, Any] = {"referenced_by": {}}
    reference_graph_summary: dict[str, Any] = {
        "edge_count": 0,
        "targets_with_incoming": 0,
    }
    reference_issue_summary: dict = {
        "total": 0,
        "by_severity": {},
        "by_issue_type": {},
        "skipped": True,
        "external_ref_warnings_enabled": False,
        "oob_definition_warnings_enabled": False,
        "reference_embedded_json_enabled": False,
        "issues_suppressed_by_per_record_cap": 0,
        "reference_rules_version": REFERENCE_RULES_VERSION,
    }
    if reference_check:
        ref_scan_issues, ref_edges = run_reference_checks(
            parsed_trees,
            canonical_path_by_sid=canonical_path_by_sid,
            deleted_ids=deleted_ids,
            all_ids=all_ids,
            report_external_refs=report_external_refs,
            report_oob_definitions=report_oob_definitions,
            reference_embedded_json=reference_embedded_json,
        )
        combined = duplicate_issues + ref_scan_issues
        reference_issues, suppressed_n = apply_max_issues_per_record(combined)
        reference_graph, reference_graph_summary = build_reference_graph(ref_edges)
        reference_issue_summary = summarize_reference_issues(reference_issues)
        reference_issue_summary["skipped"] = False
        reference_issue_summary["external_ref_warnings_enabled"] = bool(report_external_refs)
        reference_issue_summary["oob_definition_warnings_enabled"] = bool(report_oob_definitions)
        reference_issue_summary["reference_embedded_json_enabled"] = bool(reference_embedded_json)
        reference_issue_summary["issues_suppressed_by_per_record_cap"] = suppressed_n
        reference_issue_summary["reference_rules_version"] = REFERENCE_RULES_VERSION

    git = resolve_git_commit(repo_root)
    lookup_by_name = build_lookup_by_name(all_records, canonical_path_by_sid)
    lookup_field_set = set(lookup_fields)
    table_name_lookups: dict[str, dict[str, str | dict[str, str]]] = {}
    for table in lookup_tables:
        table_name_lookups[table] = build_table_name_lookup(
            all_records,
            canonical_path_by_sid,
            table=table,
            lookup_fields=lookup_field_set,
        )
    script_include_filename_by_name: dict[str, str] = {}
    if "sys_script_include" in table_name_lookups and lookup_field_set == {"filename"}:
        script_include_filename_by_name = {
            k: str(v) for k, v in table_name_lookups["sys_script_include"].items()
        }
    slim_canonical = build_slim_canonical(canonical_path_by_sid)
    reference_errors = [
        it for it in reference_issues if str(it.get("severity", "")).lower() == "error"
    ]
    by_export_dir: dict[str, dict[str, int]] = {
        k: {
            "xml_files": 0,
            "record_rows": 0,
            "delete_actions": 0,
            "active_record_rows": 0,
        }
        for k in ("update", "author_elective_update", "other")
    }
    for xf in xml_files:
        try:
            rel = xf.relative_to(repo_root).as_posix()
        except ValueError:
            rel = xf.as_posix()
        by_export_dir[_export_dir_kind(rel)]["xml_files"] += 1
    for r in all_records:
        kind = _export_dir_kind(str(r.get("relative_path") or ""))
        by_export_dir[kind]["record_rows"] += 1
        if r.get("action") == "DELETE":
            by_export_dir[kind]["delete_actions"] += 1
        else:
            by_export_dir[kind]["active_record_rows"] += 1

    meta: dict = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        **git,
        "repo_root": repo_root.as_posix(),
        "generator": "servicenow_repo_index.py",
        "index_mode": "full_records" if embed_full_records else "compact",
        "summary": {
            "xml_files_scanned": len(xml_files),
            "record_rows": len(all_records),
            "unique_sys_ids": len(by_id),
            "logically_deleted_sys_ids": len(deleted_ids),
            "unique_non_deleted_sys_ids": len(active_ids),
            "by_export_dir": by_export_dir,
        },
        "app": app,
        "counts_by_table": dict(sorted(counts_by_table.items(), key=lambda kv: (-kv[1], kv[0]))),
        "lookup_by_name": lookup_by_name,
        "lookup_mode": lookup_mode,
        "lookup_tables": lookup_tables,
        "lookup_fields": lookup_fields,
        "detail_by_table": {
            k: sorted(v, key=lambda x: (x.get("name") or "", x.get("sys_id") or ""))
            for k, v in sorted(detail_by_table.items())
        },
        "errors": errors,
        "reference_issue_summary": reference_issue_summary,
        "reference_errors": dedupe_reference_issues(reference_errors),
        "_canonical_source_path_by_sys_id": dict(sorted(canonical_path_by_sid.items())),
    }
    if script_include_filename_by_name:
        meta["script_include_filename_by_name"] = script_include_filename_by_name
    if reference_check and not include_reference_warnings:
        meta["reference_warnings_omitted"] = (
            "Full reference_issues (warnings + deduped) omitted. Re-run with --include-reference-warnings."
        )
    if reference_check and not include_reference_graph:
        meta["reference_graph_omitted"] = (
            "reference_graph omitted. Re-run with --include-reference-graph."
        )
    if embed_full_records:
        meta["records"] = sorted(
            all_records,
            key=lambda r: (
                r.get("logically_deleted", False),
                r.get("table") or "",
                r.get("name") or "",
                r.get("sys_id") or "",
                r.get("relative_path") or "",
            ),
        )
    else:
        meta["records_omitted"] = (
            "Re-run with --all-records to embed every row (large). "
            "detail_by_table and lookup_by_name cover script-heavy tables."
        )
    return {
        "meta": meta,
        "canonical_body": slim_canonical,
        "reference_issues": reference_issues,
        "reference_graph": reference_graph,
        "reference_graph_summary": reference_graph_summary,
        "table_name_lookups": table_name_lookups,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Build split index files for a ServiceNow Git export repo.")
    ap.add_argument(
        "repo_root",
        nargs="?",
        default=".",
        help="Repository root (folder that should contain index.json). Default: cwd.",
    )
    ap.add_argument(
        "--all-records",
        action="store_true",
        help="Include full `records` array in index.json (can be very large). Default: compact index.",
    )
    ap.add_argument(
        "--no-reference-check",
        action="store_true",
        help="Skip mechanical reference scan entirely (no reference_errors, issues, or graph).",
    )
    ap.add_argument(
        "--include-reference-warnings",
        action="store_true",
        help="Write index.issues.json with full deduped reference_issues (warnings + errors). Default: omit.",
    )
    ap.add_argument(
        "--include-reference-graph",
        action="store_true",
        help="Write index.graph.json with reference_graph. Default: omit.",
    )
    ap.add_argument(
        "--full-canonical",
        action="store_true",
        help="Also embed canonical_source_path_by_sys_id in index.canonical.json (large). Default: slim map only.",
    )
    ap.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON with indentation. Default: minified (token-friendly).",
    )
    ap.add_argument(
        "--reference-external",
        action="store_true",
        help="Also warn on XML element sys_ids not present in this export (noisy for OOB refs).",
    )
    ap.add_argument(
        "--reference-oob-definitions",
        action="store_true",
        help="Warn when macroponent composition references a definition id not in this export (OOB layout noise).",
    )
    ap.add_argument(
        "--reference-embedded-json",
        action="store_true",
        help="On non-script-heavy tables, parse JSON in selected elements (conditions, query, …) and scan for embedded 32-char sys_ids.",
    )
    ap.add_argument(
        "--lookup-tables",
        default=",".join(DEFAULT_LOOKUP_TABLES),
        help="Comma-separated tables to build name lookups for. Default: sys_script_include.",
    )
    ap.add_argument(
        "--lookup-fields",
        default=",".join(DEFAULT_LOOKUP_FIELDS),
        help="Comma-separated fields for lookup values: filename,relative_path,sys_id,api_name,category. Default: filename.",
    )
    ap.add_argument(
        "--lookup-mode",
        choices=("compact", "inline"),
        default="compact",
        help="compact writes per-table lookup shard files + pointers; inline embeds lookup maps in index.json.",
    )
    ap.add_argument(
        "--token-report",
        action="store_true",
        help="Print per-output byte size and estimated token count (bytes/4).",
    )
    args = ap.parse_args()
    repo = Path(args.repo_root).expanduser().resolve()
    if not repo.is_dir():
        print(f"Not a directory: {repo}", file=sys.stderr)
        return 2
    lookup_tables = _parse_csv_flag(args.lookup_tables)
    if not lookup_tables:
        print("--lookup-tables must include at least one table name.", file=sys.stderr)
        return 2
    lookup_fields = _parse_csv_flag(args.lookup_fields)
    if not lookup_fields:
        print("--lookup-fields must include at least one field.", file=sys.stderr)
        return 2
    invalid_lookup_fields = [f for f in lookup_fields if f not in LOOKUP_FIELDS_ALLOWED]
    if invalid_lookup_fields:
        print(
            f"Invalid --lookup-fields value(s): {', '.join(invalid_lookup_fields)}. "
            f"Allowed: {', '.join(sorted(LOOKUP_FIELDS_ALLOWED))}.",
            file=sys.stderr,
        )
        return 2

    reference_check = not args.no_reference_check
    bundle = build_index(
        repo,
        embed_full_records=args.all_records,
        reference_check=reference_check,
        report_external_refs=args.reference_external,
        report_oob_definitions=args.reference_oob_definitions,
        reference_embedded_json=args.reference_embedded_json,
        include_reference_warnings=args.include_reference_warnings,
        include_reference_graph=args.include_reference_graph,
        lookup_tables=lookup_tables,
        lookup_fields=lookup_fields,
        lookup_mode=args.lookup_mode,
    )
    meta = bundle["meta"]
    written, size_report = write_index_outputs(
        repo,
        meta=meta,
        canonical_body=bundle["canonical_body"],
        reference_issues=bundle["reference_issues"],
        reference_graph=bundle["reference_graph"],
        reference_graph_summary=bundle["reference_graph_summary"],
        include_reference_warnings=args.include_reference_warnings and reference_check,
        include_reference_graph=args.include_reference_graph and reference_check,
        full_canonical=args.full_canonical,
        lookup_mode=args.lookup_mode,
        table_name_lookups=bundle["table_name_lookups"],
        lookup_fields=lookup_fields,
        minify=not args.pretty,
    )
    ref_err_n = len(meta.get("reference_errors") or [])
    git_short = meta.get("git_commit_short") or "unknown"
    by_dir = (meta.get("summary") or {}).get("by_export_dir") or {}
    update_n = (by_dir.get("update") or {}).get("xml_files", 0)
    elective_n = (by_dir.get("author_elective_update") or {}).get("xml_files", 0)
    print(
        f"Wrote {', '.join(written)} (schema_version={SCHEMA_VERSION}, git={git_short}, "
        f"mode={meta['index_mode']}, {meta['summary']['record_rows']} record rows, "
        f"xml update={update_n} author_elective_update={elective_n}, "
        f"{len(meta['errors'])} file warnings, reference_errors={ref_err_n}, "
        f"lookup_by_name={len(meta.get('lookup_by_name') or {})})"
    )
    if args.token_report:
        for name in sorted(size_report):
            row = size_report[name]
            print(f"size {name}: {row['bytes']} bytes (~{row['est_tokens']} tokens)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
