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
}

interface PendingHostSave {
  draftKey: string;
  absoluteStart: number;
  absoluteEnd: number;
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
  const { dir: draftsDir, usedGlobalStorage } = resolveDraftsDir(
    binding.hostUri,
    globalStorageUri
  );
  ensureDraftsDir(draftsDir, usedGlobalStorage);

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

  if (hostDoc.version !== binding.hostVersion) {
    const rediscovered = hit.layers
      ? relocateLayeredHit(hostDoc.getText(), hit, hostDoc.version, absStart)
      : detectJsonStringByKeyPath(
          hostDoc.getText(),
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

  if (hit.layers) {
    // Read the splice back through the same descent. If the layers re-decode to
    // what was typed, every encoding in the stack was applied correctly.
    const roundTrip = scriptAt(hostDoc.getText(), absStart);
    if (!roundTrip || roundTrip.code !== editedCode) {
      return fail('Write-back did not round-trip through the encoding layers.');
    }
  } else if (hit.field) {
    const field = hit.field;
    const delta = replacement.length - (absEnd - absStart);
    const fieldStart = field.bodyStartOffset;
    const fieldEnd = field.bodyEndOffset + delta;
    const rawFieldBody = hostDoc.getText().slice(fieldStart, fieldEnd);
    const decodedBody = field.isCdata
      ? rawFieldBody
      : decodeXmlEntities(rawFieldBody);
    try {
      JSON.parse(decodedBody.trim());
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'JSON parse failed after write-back';
      return fail(`Write-back left invalid JSON: ${message}`);
    }
  }

  const newEnd = absStart + replacement.length;
  saveDraft(draftsDir, hit.draftKey, editedCode, {
    hostPath: hit.hostPath,
    fieldName: hit.fieldName,
    keyPath: hit.keyPath,
    hadJavascriptWrapper: hit.hadJavascriptWrapper,
    pendingHostSave: true,
    absoluteStart: absStart,
    absoluteEnd: newEnd
  });

  binding.hit = hit;
  binding.hostVersion = hostDoc.version;
  binding.absoluteStart = absStart;
  binding.absoluteEnd = newEnd;

  rememberPendingHostSave(binding.hostUri, hit.draftKey, absStart, newEnd);

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
  absoluteEnd: number
): void {
  const key = hostUri.toString();
  const list = pendingByHost.get(key) ?? [];
  const filtered = list.filter((p) => p.draftKey !== draftKey);
  filtered.push({ draftKey, absoluteStart, absoluteEnd });
  pendingByHost.set(key, filtered);
}

/**
 * After host disk save, delete any pending drafts for that file when the
 * written token range is still present.
 */
export function onHostDocumentSaved(
  hostDoc: vscode.TextDocument,
  globalStorageUri: vscode.Uri
): void {
  const { dir: draftsDir, usedGlobalStorage } = resolveDraftsDir(
    hostDoc.uri,
    globalStorageUri
  );
  ensureDraftsDir(draftsDir, usedGlobalStorage);
  void usedGlobalStorage;

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
    const slice = text.slice(item.absoluteStart, item.absoluteEnd);
    if (!slice) {
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
        typeof meta.absoluteEnd !== 'number'
      ) {
        continue;
      }
      const slice = hostText.slice(meta.absoluteStart, meta.absoluteEnd);
      if (!slice) {
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
