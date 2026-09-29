import { extractRecordIdentities } from './recordName';
import { scanActionRowBounds } from '../parseSnXml';

/** Directory holding live application source. */
const UPDATE_DIR = 'update';
/** Sibling directory where authored deletions and residual config belong. */
const ELECTIVE_UPDATE_DIR = 'author_elective_update';

/** Target row identity from the Records navigator catalog. */
export interface ChangeActionTarget {
  table: string;
  sysId?: string;
  displayName: string;
  apiName?: string;
  startOffset: number;
}

export type ChangeActionToDeleteResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * Rewrite one primary row's `action` from `INSERT_OR_UPDATE` to `DELETE`.
 *
 * Re-resolves the row from the current text (same matching as open-record) so a
 * stale catalog offset still finds the right opening tag when the file shifted.
 */
export function changeActionToDelete(
  text: string,
  filePath: string | undefined,
  target: ChangeActionTarget
): ChangeActionToDeleteResult {
  const candidates = extractRecordIdentities(text, filePath).filter((identity) => {
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
    return { ok: false, reason: 'record row not found in file' };
  }
  candidates.sort(
    (a, b) =>
      Math.abs(a.startOffset - target.startOffset) -
      Math.abs(b.startOffset - target.startOffset)
  );
  const match = candidates[0];
  if (match.action !== 'INSERT_OR_UPDATE') {
    return {
      ok: false,
      reason: `action is ${match.action ?? '(missing)'}, not INSERT_OR_UPDATE`
    };
  }

  const bounds = scanActionRowBounds(text).find(
    (row) => row.startOffset === match.startOffset
  );
  if (!bounds) {
    return { ok: false, reason: 'could not locate action= row bounds' };
  }
  if (bounds.rawAction.toUpperCase() !== 'INSERT_OR_UPDATE') {
    return {
      ok: false,
      reason: `action is ${bounds.rawAction}, not INSERT_OR_UPDATE`
    };
  }

  return replaceOpenTagAction(text, bounds.startOffset, 'INSERT_OR_UPDATE', 'DELETE');
}

/**
 * Where an export under `update/` belongs once it becomes a DELETE: the sibling
 * `author_elective_update/`, same file name. Returns undefined when the path has
 * no `update` ancestor to swap, which covers standalone exports and files that
 * are already filed as elective.
 *
 * The nearest `update` ancestor wins, so a checkout that happens to sit under a
 * directory of that name higher up does not retarget the move. Separators are
 * preserved from the input rather than normalized, because the result is handed
 * straight back to the filesystem.
 */
export function electiveUpdatePathFor(fsPath: string): string | undefined {
  const separator = fsPath.includes('\\') ? '\\' : '/';
  const segments = fsPath.split(/[\\/]/);
  // Stop before the last segment: that is the file name, not a directory.
  for (let i = segments.length - 2; i >= 0; i--) {
    const segment = segments[i].toLowerCase();
    if (segment === ELECTIVE_UPDATE_DIR) {
      return undefined;
    }
    if (segment === UPDATE_DIR) {
      const moved = [...segments];
      moved[i] = ELECTIVE_UPDATE_DIR;
      return moved.join(separator);
    }
  }
  return undefined;
}

/**
 * Replace the action attribute value on the opening tag at `startOffset` only.
 */
function replaceOpenTagAction(
  text: string,
  startOffset: number,
  fromAction: string,
  toAction: string
): ChangeActionToDeleteResult {
  const openEnd = text.indexOf('>', startOffset);
  if (openEnd < 0 || openEnd < startOffset) {
    return { ok: false, reason: 'could not find end of opening tag' };
  }
  const openTag = text.slice(startOffset, openEnd + 1);
  const nextOpen = openTag.replace(
    new RegExp(
      `(\\baction\\s*=\\s*)(["'])${escapeRegExp(fromAction)}\\2`,
      'i'
    ),
    `$1$2${toAction}$2`
  );
  if (nextOpen === openTag) {
    return {
      ok: false,
      reason: `opening tag action is not ${fromAction}`
    };
  }
  return {
    ok: true,
    text: text.slice(0, startOffset) + nextOpen + text.slice(openEnd + 1)
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
