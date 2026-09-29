import { extractRecordIdentities } from './recordName';
import {
  extractRowFieldText,
  isCleanupAction,
  isPrimaryAction,
  scanActionRowBounds
} from '../parseSnXml';

/** Target row identity from the Records navigator catalog. */
export interface RecordRowTarget {
  table: string;
  sysId?: string;
  displayName: string;
  apiName?: string;
  startOffset: number;
}

/**
 * Outcome of removing one record from an export.
 *
 * `delete-file` means the record was the only one the file exports, so there is
 * no rewrite to make: an export with no rows left is not a valid export.
 */
export type RemoveRecordRowResult =
  | { outcome: 'delete-file' }
  | { outcome: 'rewrite'; text: string; remaining: number }
  | { outcome: 'not-found'; reason: string };

/**
 * Remove one record row from an export's XML text, plus companion rows that
 * belong to the same application-file update name (`sys_update_version`,
 * `sys_metadata_delete`, and `delete_multiple` cleanup for the same sys_id).
 *
 * Re-resolves the row from the current text (same matching as open-record) so a
 * stale catalog offset still finds the right row when the file shifted.
 */
export function removeRecordRow(
  text: string,
  filePath: string | undefined,
  target: RecordRowTarget
): RemoveRecordRowResult {
  const allBounds = scanActionRowBounds(text);
  const boundsByStart = new Map(allBounds.map((bounds) => [bounds.startOffset, bounds]));
  // extractRecordIdentities synthesizes a row for exports with no action
  // attribute at all; keeping only rows that have bounds drops those.
  const primaryRows = extractRecordIdentities(text, filePath).filter((identity) =>
    boundsByStart.has(identity.startOffset)
  );
  const candidates = primaryRows.filter((identity) => {
    if (identity.table !== target.table) {
      return false;
    }
    if (target.sysId) {
      return identity.sysId === target.sysId;
    }
    return (
      identity.displayName === target.displayName &&
      identity.apiName === target.apiName
    );
  });
  if (candidates.length === 0) {
    return { outcome: 'not-found', reason: 'record row not found in file' };
  }
  candidates.sort(
    (a, b) =>
      Math.abs(a.startOffset - target.startOffset) -
      Math.abs(b.startOffset - target.startOffset)
  );

  const matched = candidates[0];
  const matchedBounds = boundsByStart.get(matched.startOffset)!;
  const matchedXml = text.slice(matchedBounds.startOffset, matchedBounds.endOffset);
  const updateName = updateNameForRow(matched.table, matchedXml, matched.sysId);
  const relatedSysIds = relatedSysIdsForRow(matched.table, matchedXml, matched.sysId);
  // Trailing sys_id on the update name is the application file being versioned
  // or deleted — keep it so cleanup rows and the live insert can join the set.
  if (updateName) {
    const trailing = updateName.match(/_([0-9a-f]{32})$/i);
    if (trailing) {
      relatedSysIds.add(trailing[1].toLowerCase());
    }
  }

  const removeStarts = new Set<number>([matched.startOffset]);
  for (const bounds of allBounds) {
    if (removeStarts.has(bounds.startOffset)) {
      continue;
    }
    const rowXml = text.slice(bounds.startOffset, bounds.endOffset);
    if (isCompanionRow(bounds.tableName, bounds.rawAction, rowXml, updateName, relatedSysIds)) {
      removeStarts.add(bounds.startOffset);
    }
  }

  const remainingPrimary = primaryRows.filter(
    (identity) => !removeStarts.has(identity.startOffset)
  ).length;
  if (remainingPrimary === 0) {
    return { outcome: 'delete-file' };
  }

  const toRemove = allBounds
    .filter((bounds) => removeStarts.has(bounds.startOffset))
    .sort((a, b) => b.startOffset - a.startOffset);

  let next = text;
  for (const bounds of toRemove) {
    next = spliceRow(next, bounds.startOffset, bounds.endOffset);
  }
  return {
    outcome: 'rewrite',
    text: next,
    remaining: remainingPrimary
  };
}

/**
 * Update name that ties an application file to its version / delete-metadata rows.
 */
function updateNameForRow(
  table: string,
  rowXml: string,
  sysId: string | undefined
): string | undefined {
  if (table === 'sys_update_version') {
    return extractRowFieldText(rowXml, 'name');
  }
  const named = extractRowFieldText(rowXml, 'sys_update_name');
  if (named) {
    return named;
  }
  if (sysId) {
    return `${table}_${sysId}`;
  }
  return undefined;
}

/**
 * Sys ids that identify the same application file as `rowXml`.
 */
function relatedSysIdsForRow(
  table: string,
  rowXml: string,
  sysId: string | undefined
): Set<string> {
  const ids = new Set<string>();
  if (sysId) {
    ids.add(sysId.toLowerCase());
  }
  if (table === 'sys_metadata_delete') {
    const metadataId = extractRowFieldText(rowXml, 'sys_metadata');
    if (metadataId) {
      ids.add(metadataId.toLowerCase());
    }
  }
  return ids;
}

/**
 * True when `rowXml` belongs to the same application-file update as the
 * navigator target (live insert/delete, version, delete-metadata, or cleanup).
 */
function isCompanionRow(
  tableName: string,
  rawAction: string,
  rowXml: string,
  updateName: string | undefined,
  relatedSysIds: Set<string>
): boolean {
  const table = tableName.toLowerCase();
  const action = rawAction.toUpperCase();
  const lowerAction = rawAction.toLowerCase();

  if (isCleanupAction(lowerAction)) {
    if (relatedSysIds.size === 0) {
      return false;
    }
    const query = (extractAttributeValue(rowXml, 'query') || '').toLowerCase();
    const referenced = query.match(/[0-9a-f]{32}/g);
    if (!referenced) {
      return false;
    }
    // A cleanup keyed on other records too (compound query) has to stay, or
    // removing this record would strand their cleanup.
    return referenced.every((id) => relatedSysIds.has(id));
  }

  if (!isPrimaryAction(action)) {
    return false;
  }

  const rowUpdateName =
    table === 'sys_update_version'
      ? extractRowFieldText(rowXml, 'name')
      : extractRowFieldText(rowXml, 'sys_update_name');
  if (
    updateName &&
    rowUpdateName &&
    rowUpdateName.toLowerCase() === updateName.toLowerCase()
  ) {
    return true;
  }

  if (table === 'sys_metadata_delete') {
    const metadataId = extractRowFieldText(rowXml, 'sys_metadata');
    if (metadataId && relatedSysIds.has(metadataId.toLowerCase())) {
      return true;
    }
  }

  const rowSysId = extractRowFieldText(rowXml, 'sys_id');
  if (rowSysId && relatedSysIds.has(rowSysId.toLowerCase())) {
    return true;
  }

  return false;
}

function extractAttributeValue(tagXml: string, attrName: string): string | undefined {
  const open = tagXml.match(/^<[^>]+>/);
  if (!open) {
    return undefined;
  }
  const m = open[0].match(
    new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')
  );
  const value = (m?.[1] ?? m?.[2] ?? '').trim();
  return value || undefined;
}

/** Expand row bounds to include leading indent and the trailing line ending. */
function spliceRow(text: string, startOffset: number, endOffset: number): string {
  let start = startOffset;
  while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) {
    start -= 1;
  }
  let end = endOffset;
  while (text[end] === ' ' || text[end] === '\t') {
    end += 1;
  }
  if (text[end] === '\r') {
    end += 1;
  }
  if (text[end] === '\n') {
    end += 1;
  }
  return text.slice(0, start) + text.slice(end);
}
