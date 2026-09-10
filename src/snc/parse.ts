/** Named `snc` connection profile from `snc configure profile list`. */
export interface SncProfileInfo {
  name: string;
  host?: string;
  username?: string;
}

const LIVE_ACTIONS = new Set(['INSERT_OR_UPDATE', 'INSERT', 'UPDATE']);

/** One indexed export row used to decide which DELETE files can be queried. */
export interface IndexedExport {
  table: string;
  sysId?: string;
  action?: string;
  uriString: string;
  relativePath: string;
  displayName: string;
  /**
   * False for DELETE rows outside a navigator selection. Such rows still count
   * toward the file's row total so a partial selection cannot delete the file.
   */
  queryable?: boolean;
}

/** DELETE row that can be checked on the instance. */
export interface DeleteRow {
  table: string;
  sysId: string;
}

/** File holding DELETE rows eligible for an instance check. */
export interface DeleteFileCandidate {
  uriString: string;
  relativePath: string;
  displayName: string;
  rows: DeleteRow[];
  /** Primary rows in the file; when every one is pruned the file itself goes. */
  primaryRowCount: number;
}

/** Why a DELETE row was not queried. */
export interface SkipNote {
  relativePath: string;
  reason: string;
}

/** File plus the sys_ids confirmed absent on the instance. */
export interface PruneTarget {
  file: DeleteFileCandidate;
  sysIds: string[];
  removesWholeFile: boolean;
}

export type RecordQueryParse =
  | { ok: true; sysIds: Set<string> }
  | { ok: false; reason: string };

const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

/**
 * Parse the JSON document out of `snc` stdout.
 *
 * `snc` writes spinner frames ("Processing the request") and an ANSI-colored
 * status banner before the payload, so the raw stdout is never valid JSON.
 * Returns undefined when no parseable document follows that preamble.
 */
function parseCliJson(stdout: string): unknown | undefined {
  const cleaned = stdout.replace(ANSI_RE, '');
  const start = cleaned.search(/[[{]/);
  if (start < 0) {
    return undefined;
  }
  try {
    return JSON.parse(cleaned.slice(start).trim());
  } catch {
    return undefined;
  }
}

/**
 * Parse `snc configure profile list` JSON. Keys are profile names.
 */
export function parseSncProfileList(stdout: string): SncProfileInfo[] | undefined {
  const parsed = parseCliJson(stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const out: SncProfileInfo[] = [];
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!name || !value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const row = value as Record<string, unknown>;
    out.push({
      name,
      host: typeof row.host === 'string' ? row.host : undefined,
      username: typeof row.username === 'string' ? row.username : undefined
    });
  }
  return out;
}

/**
 * Parse a successful `snc record query --fields sys_id` payload.
 * Fail closed on unexpected envelopes.
 */
export function parseSncRecordQuery(stdout: string): RecordQueryParse {
  const parsed = parseCliJson(stdout);
  if (parsed === undefined) {
    return { ok: false, reason: 'no JSON payload in snc output' };
  }

  let rows: unknown;
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    // snc reports instance failures inside the payload and still exits 0.
    if (obj.error !== undefined && obj.error !== null && obj.error !== '') {
      const detail =
        typeof obj.error === 'object'
          ? (obj.error as Record<string, unknown>).message
          : obj.error;
      return {
        ok: false,
        reason:
          typeof detail === 'string' && detail
            ? `instance error: ${detail}`
            : 'instance returned an error payload'
      };
    }
    if (obj.status !== undefined && obj.status !== 'success') {
      return { ok: false, reason: `instance status ${String(obj.status)}` };
    }
    rows = obj.result;
  }

  if (!Array.isArray(rows)) {
    return { ok: false, reason: 'unexpected JSON shape' };
  }
  const sysIds = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, reason: 'query row is not an object' };
    }
    const sysId = (row as Record<string, unknown>).sys_id;
    if (typeof sysId !== 'string' || !sysId) {
      return { ok: false, reason: 'query row is missing a string sys_id' };
    }
    sysIds.add(sysId.toLowerCase());
  }
  return { ok: true, sysIds };
}

/**
 * Split sys_ids so `sys_idIN…` stays under an encoded-query length budget.
 */
export function chunkSysIds(ids: string[], maxChars = 8000): string[][] {
  const prefixLen = 'sys_idIN'.length;
  const chunks: string[][] = [];
  let current: string[] = [];
  let len = prefixLen;
  for (const id of ids) {
    const extra = (current.length === 0 ? 0 : 1) + id.length;
    if (current.length > 0 && len + extra > maxChars) {
      chunks.push(current);
      current = [id];
      len = prefixLen + id.length;
    } else {
      current.push(id);
      len += extra;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Collect DELETE rows whose sys_id has no live export elsewhere in the index.
 *
 * Files that mix DELETE with other actions stay eligible: only their DELETE
 * rows are queried, and pruning rewrites the file instead of removing it.
 */
export function selectDeleteQueryCandidates(records: IndexedExport[]): {
  candidates: DeleteFileCandidate[];
  skipped: SkipNote[];
} {
  const liveIds = new Set<string>();
  for (const record of records) {
    if (record.sysId && record.action && LIVE_ACTIONS.has(record.action)) {
      liveIds.add(record.sysId.toLowerCase());
    }
  }

  const byUri = new Map<string, IndexedExport[]>();
  for (const record of records) {
    const list = byUri.get(record.uriString);
    if (list) {
      list.push(record);
    } else {
      byUri.set(record.uriString, [record]);
    }
  }

  const candidates: DeleteFileCandidate[] = [];
  const skipped: SkipNote[] = [];
  for (const rows of byUri.values()) {
    const eligible: DeleteRow[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.action !== 'DELETE' || row.queryable === false) {
        continue;
      }
      if (!row.sysId) {
        skipped.push({
          relativePath: row.relativePath,
          reason: 'DELETE row has no sys_id'
        });
        continue;
      }
      const id = row.sysId.toLowerCase();
      if (liveIds.has(id)) {
        skipped.push({
          relativePath: row.relativePath,
          reason: `sys_id ${id} still has a live export`
        });
        continue;
      }
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      eligible.push({ table: row.table, sysId: id });
    }
    if (eligible.length === 0) {
      continue;
    }
    candidates.push({
      uriString: rows[0].uriString,
      relativePath: rows[0].relativePath,
      displayName: rows[0].displayName,
      rows: eligible,
      primaryRowCount: rows.length
    });
  }
  return { candidates, skipped };
}

/**
 * Per-file sys_ids that a successful query proved absent from the instance.
 * Tables whose query failed are not present in `presentByTable`, so their rows
 * never become prune targets.
 */
export function confirmedMissingByFile(
  candidates: DeleteFileCandidate[],
  presentByTable: Map<string, Set<string>>
): PruneTarget[] {
  const targets: PruneTarget[] = [];
  for (const file of candidates) {
    const sysIds: string[] = [];
    for (const row of file.rows) {
      const present = presentByTable.get(row.table);
      if (present && !present.has(row.sysId)) {
        sysIds.push(row.sysId);
      }
    }
    if (sysIds.length === 0) {
      continue;
    }
    targets.push({
      file,
      sysIds,
      removesWholeFile: sysIds.length === file.primaryRowCount
    });
  }
  return targets;
}
