import { extractRecordIdentities } from '../navigator/recordName';
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
 * Reports `delete-file` when nothing else remains, so the caller removes the
 * file instead of leaving an export with no rows in it.
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
  if (removing.length === primaryRows.length) {
    return { outcome: 'delete-file', removed: removing.length };
  }

  // Cut from the end so earlier offsets stay valid as the text shrinks.
  const ranges = removing
    .map((identity) => boundsByStart.get(identity.startOffset)!)
    .sort((a, b) => b.startOffset - a.startOffset);
  let next = text;
  for (const range of ranges) {
    let start = range.startOffset;
    while (start > 0 && (next[start - 1] === ' ' || next[start - 1] === '\t')) {
      start -= 1;
    }
    let end = range.endOffset;
    while (next[end] === ' ' || next[end] === '\t') {
      end += 1;
    }
    if (next[end] === '\r') {
      end += 1;
    }
    if (next[end] === '\n') {
      end += 1;
    }
    next = next.slice(0, start) + next.slice(end);
  }
  return { outcome: 'rewrite', removed: removing.length, text: next };
}
