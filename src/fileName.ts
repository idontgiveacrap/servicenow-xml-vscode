import * as path from 'path';

/**
 * Parse basename `{table}_{sys_id}.xml` when it matches the export convention.
 */
export function parseExportFileName(
  filePath: string | undefined
): { table: string; sysId: string } | undefined {
  if (!filePath) {
    return undefined;
  }
  const base = path.basename(filePath);
  const m = base.match(/^([A-Za-z_][\w.-]*)_([0-9a-f]{32})\.xml$/i);
  if (!m) {
    return undefined;
  }
  return { table: m[1], sysId: m[2].toLowerCase() };
}

/**
 * True when the path is `{sys_id}/sys_app_{sys_id}.xml` (same 32-hex id).
 */
export function matchesSnAppMarker(fsPath: string): boolean {
  const parsed = parseExportFileName(fsPath);
  if (!parsed || parsed.table.toLowerCase() !== 'sys_app') {
    return false;
  }
  const parent = path.basename(path.dirname(fsPath));
  return parent.toLowerCase() === parsed.sysId;
}
