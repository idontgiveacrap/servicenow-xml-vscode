#!/usr/bin/env python3
"""
Cursor sessionStart hook: refresh ServiceNow repo index when the workspace
looks like a scoped-app Git export and index.json is missing, behind HEAD, or
older than export XML files (uncommitted edits).

Installed by the servicenow-xml extension (managed-by: servicenow-xml).

Writes {} (or additional_context) to stdout for the hooks protocol.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

MARKER = "servicenow-xml"
HELPERS_ROOT = Path.home() / ".cursor" / "servicenow-xml"
INDEXER = HELPERS_ROOT / "scripts" / "servicenow_repo_index.py"
LOG_DIR = HELPERS_ROOT / "logs"


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
    True only when the workspace holds the ServiceNow scoped-app marker
    `{sys_id}/sys_app_{sys_id}.xml` (same 32-hex id in folder name and filename)
    one level below the root. Matches the extension's workspace gate
    (matchesSnAppMarker in src/fileName.ts); index.json / a bare update/ folder
    are intentionally not sufficient.
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


def _git_head(root: Path) -> str | None:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout.strip() or None


def _index_commit(root: Path) -> str | None:
    path = root / "index.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    commit = data.get("git_commit")
    return commit if isinstance(commit, str) and commit else None


def _index_mtime(root: Path) -> float | None:
    path = root / "index.json"
    try:
        return path.stat().st_mtime if path.is_file() else None
    except OSError:
        return None


def _export_xml_newer_than_index(root: Path, index_mtime: float) -> bool:
    """
    True when any likely export XML under the workspace is newer than index.json.
    Cheap one-level walk of {sys_id}/update and {sys_id}/author_elective_update.
    """
    try:
        children = list(root.iterdir())
    except OSError:
        return False
    for child in children:
        if not child.is_dir():
            continue
        name = child.name
        if not (len(name) == 32 and all(c in "0123456789abcdef" for c in name.lower())):
            continue
        for sub in ("update", "author_elective_update"):
            folder = child / sub
            if not folder.is_dir():
                continue
            try:
                for entry in folder.iterdir():
                    if not entry.is_file() or entry.suffix.lower() != ".xml":
                        continue
                    try:
                        if entry.stat().st_mtime > index_mtime:
                            return True
                    except OSError:
                        continue
            except OSError:
                continue
    return False


def _index_is_current(root: Path) -> bool:
    """
    Current when index.json exists, matches HEAD (when in a git repo), and no
    export XML is newer than the index file. Non-git workspaces rely on mtimes.
    """
    indexed = _index_commit(root)
    index_mtime = _index_mtime(root)
    if index_mtime is None:
        return False
    head = _git_head(root)
    if head is not None:
        if not indexed or head != indexed:
            return False
    if _export_xml_newer_than_index(root, index_mtime):
        return False
    return True


def _python_cmd() -> list[str]:
    override = os.environ.get("SERVICENOW_XML_PYTHON", "").strip()
    if override:
        return [override]
    return [sys.executable]


def _run_indexer(root: Path) -> tuple[bool, str]:
    if not INDEXER.is_file():
        return False, f"indexer missing: {INDEXER}"
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / "session-start-index.log"
    cmd = _python_cmd() + [str(INDEXER), str(root)]
    try:
        completed = subprocess.run(
            cmd,
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)

    try:
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(f"\n--- {root} ---\n")
            fh.write(completed.stdout or "")
            fh.write(completed.stderr or "")
            fh.write(f"\nexit={completed.returncode}\n")
    except OSError:
        pass

    if completed.returncode != 0:
        err = (completed.stderr or completed.stdout or "indexer failed").strip()
        return False, err[:500]
    return True, "index refreshed"


def main() -> int:
    payload = _read_stdin()
    roots = payload.get("workspace_roots") or []
    if not isinstance(roots, list):
        roots = []

    refreshed: list[str] = []
    skipped: list[str] = []
    errors: list[str] = []

    for raw in roots:
        if not isinstance(raw, str) or not raw.strip():
            continue
        root = Path(raw)
        if not _looks_like_sn_export(root):
            skipped.append(f"{root}: not a ServiceNow export")
            continue
        if _index_is_current(root):
            head = _git_head(root)
            tag = head[:8] if head else "mtime"
            skipped.append(f"{root}: index current ({tag})")
            continue
        ok, detail = _run_indexer(root)
        if ok:
            refreshed.append(str(root))
        else:
            errors.append(f"{root}: {detail}")

    context_parts = [f"[{MARKER}]"]
    if refreshed:
        context_parts.append("Refreshed ServiceNow index for: " + ", ".join(refreshed))
    if errors:
        context_parts.append("Indexer errors: " + "; ".join(errors))
    # Keep quiet when nothing happened — empty additional_context is fine.
    out: dict = {}
    if refreshed or errors:
        out["additional_context"] = " ".join(context_parts)
    _emit(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
