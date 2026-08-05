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
