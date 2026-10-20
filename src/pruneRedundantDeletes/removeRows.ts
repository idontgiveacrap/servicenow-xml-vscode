import { extractRecordIdentities } from '../navigator/recordName';
import { removeRecordRow } from '../navigator/removeRecordRow';
import { scanActionRowBounds } from '../parseSnXml';

/**
 * Result of removing confirmed DELETE rows from one export.
 *
 * `mismatch` means the rows on disk no longer match what was queried, so the
 * caller must leave the file alone rather than cut against stale bounds.
 */
export type RemoveDeleteRowsResult =
  | { outcome: 'delete-file'; removed: number }
  | { outcome: 'rewrite'; removed: number; text: string }
  | { outcome: 'mismatch'; removed: number; expected: number };

/**
 * Drop the DELETE rows named by `sysIds` from an export's XML text.
 *
 * Row removal, companion versions and delete metadata, and the whole-file
 * decision all go through `removeRecordRow` — the same path as Delete from disk.
 * This function only checks that each requested sys_id is still a DELETE row.
 * Reports `delete-file` when that removal leaves no other records.
 */
export function removeDeleteRows(
  text: string,
  filePath: string | undefined,
  sysIds: Iterable<string>
): RemoveDeleteRowsResult {
  const wanted = new Set([...sysIds].map((id) => id.toLowerCase()));
  const boundsByStart = new Map(
    scanActionRowBounds(text).map((bounds) => [bounds.startOffset, bounds])
  );
  // extractRecordIdentities synthesizes a row for exports with no action
  // attribute at all; keeping only rows that have bounds drops those.
  const primaryRows = extractRecordIdentities(text, filePath).filter((identity) =>
    boundsByStart.has(identity.startOffset)
  );
  const removing = primaryRows.filter(
    (identity) =>
      identity.action === 'DELETE' &&
      identity.sysId &&
      wanted.has(identity.sysId.toLowerCase())
  );

  if (removing.length !== wanted.size) {
    return {
      outcome: 'mismatch',
      removed: removing.length,
      expected: wanted.size
    };
  }

  const result = removeRecordRow(text, filePath, removing);
  if (result.outcome === 'not-found') {
    return {
      outcome: 'mismatch',
      removed: 0,
      expected: wanted.size
    };
  }
  if (result.outcome === 'delete-file') {
    return { outcome: 'delete-file', removed: removing.length };
  }
  return { outcome: 'rewrite', removed: removing.length, text: result.text };
}
