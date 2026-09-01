import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { decodeXmlEntities, encodeXmlEntities } from '../parseSnXml';
import {
  restoreJavascriptWrapper,
  toJsonStringToken,
  wouldBreakCdata
} from './escape';
import { detectJsonStringByKeyPath, type JsonStringHit } from './detect';
import { scriptAt } from '../scriptHits';
import { encodeThroughLayers } from '../embedded/layers';
import {
  deleteDraft,
  ensureDraftsDir,
  loadDraft,
  resolveDraftsDir,
  saveDraft
} from './drafts';

export interface WriteBackBinding {
  hit: JsonStringHit;
  hostUri: vscode.Uri;
  hostVersion: number;
  absoluteStart: number;
  absoluteEnd: number;
  /**
   * Exact host text this session expects to find in the range it replaces.
   * Substitution is authorized by this value, not by the offsets: offsets and
   * document versions only locate a candidate span, and a span whose content has
   * drifted is re-found or refused rather than overwritten.
   */
  expectedSlice: string;
}

interface PendingHostSave {
  draftKey: string;
  absoluteStart: number;
  absoluteEnd: number;
  writtenSha256: string;
}

/** Content hash used to confirm a written range still holds what was written. */
function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Pending host-save confirmations that outlive the temp editor session. */
const pendingByHost = new Map<string, PendingHostSave[]>();

export type WriteBackResult =
  | { ok: true; pendingHostSave: true }
  | { ok: false; error: string; drafted: boolean; usedGlobalStorage: boolean };

/**
 * Write edited script back into the host XML as a single JSON string token splice.
 */
export async function writeBackJsonString(
  binding: WriteBackBinding,
  editedCode: string,
  globalStorageUri: vscode.Uri
): Promise<WriteBackResult> {
  const {
    dir: draftsDir,
    usedGlobalStorage,
    workspaceRoot
  } = resolveDraftsDir(binding.hostUri, globalStorageUri);
  ensureDraftsDir(draftsDir, workspaceRoot);

  const fail = (error: string): WriteBackResult => {
    saveDraft(draftsDir, binding.hit.draftKey, editedCode, {
      hostPath: binding.hit.hostPath,
      fieldName: binding.hit.fieldName,
      keyPath: binding.hit.keyPath,
      hadJavascriptWrapper: binding.hit.hadJavascriptWrapper,
      lastError: error,
      pendingHostSave: false
    });
    return { ok: false, error, drafted: true, usedGlobalStorage };
  };

  const hostDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === binding.hostUri.toString()
  );
  if (!hostDoc) {
    return fail('Host document is no longer open.');
  }

  let hit = binding.hit;
  let absStart = binding.absoluteStart;
  let absEnd = binding.absoluteEnd;
  // Read once: everything below is computed against this snapshot, and there is
  // no await between here and applyEdit, so the buffer cannot move underneath.
  const text = hostDoc.getText();

  // Re-find the span whenever the bytes there are not the ones this session
  // expects, rather than trusting a matching document version.
  if (text.slice(absStart, absEnd) !== binding.expectedSlice) {
    const rediscovered = hit.layers
      ? relocateLayeredHit(text, hit, hostDoc.version, absStart)
      : detectJsonStringByKeyPath(
          text,
          binding.hit.hostPath,
          hostDoc.version,
          binding.hit.fieldName,
          binding.hit.keyPath,
          binding.hit.stableHostId
        );
    if (!rediscovered) {
      return fail(
        'Host changed and the embedded script could not be re-located; draft saved.'
      );
    }
    hit = rediscovered;
    absStart = rediscovered.absoluteStart;
    absEnd = rediscovered.absoluteEnd;
  }

  let replacement: string;
  if (hit.layers) {
    // The layer stack already contains the javascript() wrapper (when the
    // original had one) and every enclosing encoding, so the edited source goes
    // in raw and comes out ready to splice.
    const encoded = encodeThroughLayers(editedCode, hit.layers);
    if (!encoded.ok) {
      return fail(encoded.error);
    }
    replacement = encoded.text;
  } else {
    const field = hit.field;
    if (!field) {
      return fail('Hit is missing both encoding layers and a field body.');
    }
    const payload = restoreJavascriptWrapper(
      editedCode,
      hit.hadJavascriptWrapper
    );
    const token = toJsonStringToken(payload);
    if (field.isCdata) {
      if (wouldBreakCdata(token)) {
        return fail('Replacement would terminate CDATA (contains ]]>).');
      }
      replacement = token;
    } else if (field.content !== field.decodedContent) {
      replacement = encodeXmlEntities(token);
    } else {
      replacement = token;
    }

    if (absStart < field.bodyStartOffset || absEnd > field.bodyEndOffset) {
      return fail('String range is outside the JSON field body.');
    }
  }

  // Validate the spliced result before it reaches the buffer. These checks used
  // to run after applyEdit, so a rejected splice stayed in the document with only
  // an error message to say so.
  const nextText = text.slice(0, absStart) + replacement + text.slice(absEnd);

  if (hit.layers) {
    // Read the splice back through the same descent. If the layers re-decode to
    // what was typed, every encoding in the stack was applied correctly.
    const roundTrip = scriptAt(nextText, absStart);
    if (!roundTrip || roundTrip.code !== editedCode) {
      return fail('Write-back would not round-trip through the encoding layers.');
    }
  } else if (hit.field) {
    const field = hit.field;
    const delta = replacement.length - (absEnd - absStart);
    const fieldStart = field.bodyStartOffset;
    const fieldEnd = field.bodyEndOffset + delta;
    const rawFieldBody = nextText.slice(fieldStart, fieldEnd);
    const decodedBody = field.isCdata
      ? rawFieldBody
      : decodeXmlEntities(rawFieldBody);
    try {
      JSON.parse(decodedBody.trim());
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'JSON parse failed before write-back';
      return fail(`Write-back would leave invalid JSON: ${message}`);
    }
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    hostDoc.uri,
    new vscode.Range(hostDoc.positionAt(absStart), hostDoc.positionAt(absEnd)),
    replacement
  );

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    return fail('Workspace edit was rejected.');
  }
  if (hostDoc.getText() !== nextText) {
    return fail(
      'Host document changed while the write-back was applied; draft saved.'
    );
  }

  const newEnd = absStart + replacement.length;
  const writtenSha256 = sha256(replacement);
  saveDraft(draftsDir, hit.draftKey, editedCode, {
    hostPath: hit.hostPath,
    fieldName: hit.fieldName,
    keyPath: hit.keyPath,
    hadJavascriptWrapper: hit.hadJavascriptWrapper,
    pendingHostSave: true,
    absoluteStart: absStart,
    absoluteEnd: newEnd,
    writtenSha256
  });

  // The host now holds the edited code, so that is what a later re-location has
  // to match; keeping the originally opened code here would make every write
  // after the first fail to re-locate.
  binding.hit = { ...hit, editorCode: editedCode };
  binding.hostVersion = hostDoc.version;
  binding.absoluteStart = absStart;
  binding.absoluteEnd = newEnd;
  binding.expectedSlice = replacement;

  rememberPendingHostSave(
    binding.hostUri,
    hit.draftKey,
    absStart,
    newEnd,
    writtenSha256
  );

  return { ok: true, pendingHostSave: true };
}

/**
 * Re-find a layered hit after the host document changed.
 *
 * Deliberately conservative: it only re-descends at the remembered offset and
 * requires the script found there to still be the one that was opened. Anything
 * else fails into a draft, because guessing at a new location risks splicing
 * over unrelated XML.
 */
function relocateLayeredHit(
  text: string,
  hit: JsonStringHit,
  hostVersion: number,
  absoluteStart: number
): JsonStringHit | null {
  const found = scriptAt(text, absoluteStart);
  if (!found || found.fieldName !== hit.fieldName) {
    return null;
  }
  if (found.code !== hit.editorCode) {
    return null;
  }
  return {
    ...hit,
    hostVersion,
    absoluteStart: found.hostStart,
    absoluteEnd: found.hostEnd,
    layers: found.layers
  };
}

function rememberPendingHostSave(
  hostUri: vscode.Uri,
  draftKey: string,
  absoluteStart: number,
  absoluteEnd: number,
  writtenSha256: string
): void {
  const key = hostUri.toString();
  const list = pendingByHost.get(key) ?? [];
  const filtered = list.filter((p) => p.draftKey !== draftKey);
  filtered.push({ draftKey, absoluteStart, absoluteEnd, writtenSha256 });
  pendingByHost.set(key, filtered);
}

/**
 * After host disk save, delete any pending drafts for that file whose written
 * text is still exactly what the saved document holds at that range.
 */
export function onHostDocumentSaved(
  hostDoc: vscode.TextDocument,
  globalStorageUri: vscode.Uri
): void {
  const { dir: draftsDir, workspaceRoot } = resolveDraftsDir(
    hostDoc.uri,
    globalStorageUri
  );
  ensureDraftsDir(draftsDir, workspaceRoot);

  const key = hostDoc.uri.toString();
  const text = hostDoc.getText();
  const pending = pendingByHost.get(key) ?? [];
  const remaining: PendingHostSave[] = [];
  const cleared = new Set<string>();

  for (const item of pending) {
    const draft = loadDraft(draftsDir, item.draftKey);
    if (!draft?.meta.pendingHostSave) {
      continue;
    }
    // A range that merely exists proves nothing: keep the draft unless the saved
    // file still holds the exact text that was written there.
    if (
      sha256(text.slice(item.absoluteStart, item.absoluteEnd)) !==
      item.writtenSha256
    ) {
      remaining.push(item);
      continue;
    }
    deleteDraft(draftsDir, item.draftKey);
    cleared.add(item.draftKey);
  }
  if (remaining.length === 0) {
    pendingByHost.delete(key);
  } else {
    pendingByHost.set(key, remaining);
  }

  clearPendingDraftsOnDisk(draftsDir, hostDoc.uri.fsPath, text, cleared);
}

function clearPendingDraftsOnDisk(
  draftsDir: string,
  hostFsPath: string,
  hostText: string,
  alreadyCleared: Set<string>
): void {
  if (!fs.existsSync(draftsDir)) {
    return;
  }
  for (const name of fs.readdirSync(draftsDir)) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const full = path.join(draftsDir, name);
    try {
      const meta = JSON.parse(fs.readFileSync(full, 'utf8')) as {
        hostPath?: string;
        pendingHostSave?: boolean;
        draftKey?: string;
        absoluteStart?: number;
        absoluteEnd?: number;
        writtenSha256?: string;
      };
      if (
        !meta.pendingHostSave ||
        !meta.hostPath ||
        !meta.draftKey ||
        !pathsEqual(meta.hostPath, hostFsPath) ||
        alreadyCleared.has(meta.draftKey)
      ) {
        continue;
      }
      if (
        typeof meta.absoluteStart !== 'number' ||
        typeof meta.absoluteEnd !== 'number' ||
        typeof meta.writtenSha256 !== 'string'
      ) {
        continue;
      }
      if (
        sha256(hostText.slice(meta.absoluteStart, meta.absoluteEnd)) !==
        meta.writtenSha256
      ) {
        continue;
      }
      deleteDraft(draftsDir, meta.draftKey);
    } catch {
      // skip bad meta
    }
  }
}

function pathsEqual(a: string, b: string): boolean {
  return (
    a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
  );
}

/** @internal exposed for tests */
export function _resetPendingHostSavesForTests(): void {
  pendingByHost.clear();
}
