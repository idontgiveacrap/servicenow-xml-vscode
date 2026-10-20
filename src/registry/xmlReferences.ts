/**
 * sys_id edges inside export XML. Only an element whose entire text is a
 * 32-char id counts, so script and JSON bodies are not treated as foreign keys.
 */

import { extractRecordIdentities } from '../navigator/recordName';

/** Hard cap so one workspace cannot write an unbounded edge list. */
export const MAX_REFERENCE_EDGES = 12000;

/** Element names whose 32-char text is the row itself or not a Glide reference. */
const IGNORE_TAGS = new Set([
  'sys_id',
  'source',
  'update_guid',
  'remote_sys_id',
  'remote_update_set',
  'sys_mod_count'
]);

/** Embedded code / markup. A body that is only a sys_id is still not a reference. */
const SKIP_TAGS = new Set([
  'script',
  'xml',
  'conditions',
  'query',
  'term',
  'annotation',
  'template',
  'operation_query',
  'calculation',
  'filter',
  'advanced',
  'client_transform_script',
  'client_script',
  'script_plain',
  'payload_template',
  'hint',
  'example'
]);

const SYS_ID_ELEMENT =
  /<([A-Za-z_][\w]*)\b[^>]*>([a-fA-F0-9]{32})<\/\1>/g;

/** One outgoing sys_id reference from an export row. */
export interface XmlReferenceEdge {
  fromSysId?: string;
  fromTable: string;
  toSysId: string;
  element: string;
  uri: string;
  relativePath: string;
  /** UTF-16 offset of the target sys_id text. */
  startOffset: number;
}

export type ReferenceTargetState = 'in_project' | 'deleted' | 'not_in_project';

/**
 * Collect reference edges from one export. DELETE rows are not sources.
 * `fromSysId` pointing at itself is skipped.
 */
export function extractXmlReferences(
  text: string,
  location: { uri: string; relativePath: string }
): XmlReferenceEdge[] {
  const rows = extractRecordIdentities(text, location.relativePath);
  const ranges =
    rows.length > 0
      ? rows.map((row, index) => ({
          start: row.startOffset,
          end: rows[index + 1]?.startOffset ?? text.length,
          table: row.table,
          sysId: row.sysId,
          action: row.action
        }))
      : [{ start: 0, end: text.length, table: '', sysId: undefined, action: undefined }];

  const edges: XmlReferenceEdge[] = [];
  const seen = new Set<string>();
  for (const range of ranges) {
    if (range.action === 'DELETE' || !range.table) {
      continue;
    }
    const slice = text.slice(range.start, range.end);
    SYS_ID_ELEMENT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SYS_ID_ELEMENT.exec(slice))) {
      const element = match[1].toLowerCase();
      if (IGNORE_TAGS.has(element) || SKIP_TAGS.has(element)) {
        continue;
      }
      const toSysId = match[2].toLowerCase();
      if (range.sysId && toSysId === range.sysId.toLowerCase()) {
        continue;
      }
      const key = `${range.sysId ?? ''}|${element}|${toSysId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const idAt = match[0].indexOf(match[2]);
      edges.push({
        fromSysId: range.sysId,
        fromTable: range.table,
        toSysId,
        element,
        uri: location.uri,
        relativePath: location.relativePath,
        startOffset: range.start + match.index + (idAt >= 0 ? idAt : 0)
      });
    }
  }
  return edges;
}

/**
 * Live rows win over DELETE. Ids with only DELETE rows are deleted targets.
 */
/**
 * One pass over export rows. A live row wins when the same sys_id is also deleted.
 */
export function referenceTargetIndex(
  records: Array<{ sysId?: string; action?: string }>
): (sysId: string) => ReferenceTargetState {
  const live = new Set<string>();
  const deleted = new Set<string>();
  for (const record of records) {
    if (!record.sysId) {
      continue;
    }
    const id = record.sysId.toLowerCase();
    if (record.action === 'DELETE') {
      deleted.add(id);
    } else {
      live.add(id);
    }
  }
  return (sysId: string) => {
    const id = sysId.toLowerCase();
    if (live.has(id)) {
      return 'in_project';
    }
    if (deleted.has(id)) {
      return 'deleted';
    }
    return 'not_in_project';
  };
}

/**
 * Whether a referenced sys_id is a live export row, a DELETE-only row, or absent.
 */
export function referenceTargetState(
  records: Array<{ sysId?: string; action?: string }>,
  sysId: string
): ReferenceTargetState {
  return referenceTargetIndex(records)(sysId);
}
