/**
 * Workspace reference search for a ServiceNow sys_id (vscode-free).
 * XML reference fields come from the scan cache; script/JSON bodies are scanned separately.
 */

import {
  decodeXmlEntities,
  parseSnXml,
  scanDirectChildElements
} from '../parseSnXml';
import { listJsonFields, listScriptFields } from '../scriptHits';
import type { CachedReference } from './cache';

/** One occurrence of a sys_id in an export file. */
export interface SysIdReferenceHit {
  uri: string;
  startOffset: number;
  endOffset: number;
}

const SYS_ID_LEN = 32;
const HEX32 = /[a-f0-9]{32}/gi;

/**
 * Normalize a sys_id for comparison. Returns undefined when not 32 hex chars.
 */
export function normalizeSysId(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * Workspace references to one sys_id: defining rows, XML reference elements, and
 * occurrences inside embedded script or JSON (not plain XML reference fields).
 */
export function findSysIdReferences(input: {
  sysId: string;
  referenceEdges: CachedReference[];
  exportUris: string[];
  readText: (uri: string) => string | undefined;
  /** Unsaved buffer text keyed by uri string. */
  openTextByUri?: ReadonlyMap<string, string>;
}): SysIdReferenceHit[] {
  const target = normalizeSysId(input.sysId);
  if (!target) {
    return [];
  }
  const seen = new Set<string>();
  const hits: SysIdReferenceHit[] = [];
  const add = (uri: string, startOffset: number, endOffset: number): void => {
    const key = `${uri}|${startOffset}|${endOffset}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    hits.push({ uri, startOffset, endOffset });
  };

  for (const edge of input.referenceEdges) {
    if (edge.toSysId.toLowerCase() !== target) {
      continue;
    }
    add(edge.uri, edge.startOffset, edge.startOffset + SYS_ID_LEN);
  }

  const uris = new Set(input.exportUris);
  for (const edge of input.referenceEdges) {
    uris.add(edge.uri);
  }

  for (const uri of uris) {
    const text =
      input.openTextByUri?.get(uri) ?? input.readText(uri);
    if (!text) {
      continue;
    }
    collectSysIdDefinitionHits(text, uri, target, add);
    collectEmbeddedSysIdHits(text, uri, target, add);
  }

  hits.sort((a, b) =>
    a.uri === b.uri ? a.startOffset - b.startOffset : a.uri.localeCompare(b.uri)
  );
  return hits;
}

/**
 * Workspace references to a Script Include or platform API identifier.
 * Deferred until declared scripts and objects are fully indexed on the Registry.
 */
export function findSymbolReferences(_name: string): SysIdReferenceHit[] {
  return [];
}

function collectSysIdDefinitionHits(
  text: string,
  uri: string,
  target: string,
  add: (uri: string, start: number, end: number) => void
): void {
  const doc = parseSnXml(text);
  for (const row of doc.rows) {
    if (!row.sysId || row.sysId.toLowerCase() !== target) {
      continue;
    }
    const rowSlice = text.slice(row.startOffset, row.endOffset);
    const sysIdEl = scanDirectChildElements(rowSlice).find(
      (element) => element.name.toLowerCase() === 'sys_id'
    );
    if (!sysIdEl) {
      continue;
    }
    const body = rowSlice.slice(sysIdEl.bodyStart, sysIdEl.bodyEnd);
    const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/s.exec(body.trim());
    const rawValue = (cdata ? cdata[1] : decodeXmlEntities(body)).trim();
    const idStart = body.indexOf(rawValue);
    if (idStart < 0) {
      continue;
    }
    const absolute = row.startOffset + sysIdEl.bodyStart + idStart;
    add(uri, absolute, absolute + SYS_ID_LEN);
  }
}

function collectEmbeddedSysIdHits(
  text: string,
  uri: string,
  target: string,
  add: (uri: string, start: number, end: number) => void
): void {
  const doc = parseSnXml(text);
  const fields = [...listScriptFields(doc), ...listJsonFields(doc)];
  for (const hit of fields) {
    HEX32.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HEX32.exec(hit.code))) {
      if (match[0].toLowerCase() !== target) {
        continue;
      }
      const start = mapCodeOffsetToHost(text, hit, match.index);
      const end = mapCodeOffsetToHost(text, hit, match.index + SYS_ID_LEN);
      if (start !== undefined && end !== undefined) {
        add(uri, start, end);
      }
    }
  }
}

/**
 * Map an offset inside decoded script/JSON code back to the host XML document.
 */
function mapCodeOffsetToHost(
  text: string,
  hit: { hostStart: number; hostEnd: number; code: string },
  codeOffset: number
): number | undefined {
  const clamped = Math.min(Math.max(codeOffset, 0), hit.code.length);
  const hostSlice = text.slice(hit.hostStart, hit.hostEnd);
  if (hostSlice === hit.code) {
    return hit.hostStart + clamped;
  }
  let hostIndex = 0;
  let codeIndex = 0;
  while (hostIndex < hostSlice.length && codeIndex < clamped) {
    if (hostSlice[hostIndex] === hit.code[codeIndex]) {
      hostIndex++;
      codeIndex++;
      continue;
    }
    if (hostSlice.startsWith('&lt;', hostIndex)) {
      hostIndex += 4;
      if (hit.code[codeIndex] === '<') {
        codeIndex++;
      }
      continue;
    }
    if (hostSlice.startsWith('&gt;', hostIndex)) {
      hostIndex += 4;
      if (hit.code[codeIndex] === '>') {
        codeIndex++;
      }
      continue;
    }
    if (hostSlice.startsWith('&amp;', hostIndex)) {
      hostIndex += 5;
      if (hit.code[codeIndex] === '&') {
        codeIndex++;
      }
      continue;
    }
    if (hostSlice.startsWith('&#', hostIndex)) {
      const semi = hostSlice.indexOf(';', hostIndex);
      if (semi === -1) {
        break;
      }
      hostIndex = semi + 1;
      codeIndex++;
      continue;
    }
    hostIndex++;
  }
  return hit.hostStart + hostIndex;
}
