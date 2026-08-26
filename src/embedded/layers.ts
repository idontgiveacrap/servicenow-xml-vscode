/**
 * Encoding-layer descent for embedded scripts.
 *
 * ServiceNow nests script text behind a variable stack of encodings: a script
 * field may sit in CDATA, in an entity-encoded text node, inside a nested
 * record_update document that is itself entity-encoded inside a <payload>, or
 * inside a JSON string inside any of those. Rather than enumerate those shapes,
 * this walks inward from a document offset one layer at a time and records how
 * to get back out.
 *
 * Each layer contributes an encode step. Write-back re-applies them innermost to
 * outermost and splices the result over [absoluteStart, absoluteEnd), so the
 * caller never has to know which combination it is looking at.
 */

import type { JSONVisitor } from 'jsonc-parser/lib/esm/main.js';
import { visit } from 'jsonc-parser/lib/esm/main.js';
import { decodeXmlEntities, encodeXmlEntities } from '../parseSnXml';
import { buildDecodedToRawMap } from '../jsonStringEditor/escape';
import { stripJavascriptWrapper } from '../jsonStringEditor/escape';
import { resolveScriptProfile } from '../scriptProfile';
import { looksLikeJavaScript } from './jsLikeness';

/** How many nested documents to follow before giving up. */
const MAX_DEPTH = 6;

const CDATA_OPEN = '<![CDATA[';

export type EncodingLayerKind =
  | 'cdata'
  | 'xmlText'
  | 'xmlDocument'
  | 'jsonString'
  | 'jsWrapper';

export interface EncodingLayer {
  kind: EncodingLayerKind;
  /** XML tag the layer came from, when applicable. */
  fieldName?: string;
}

export interface EmbeddedScriptHit {
  /** Range in the host document that write-back replaces. */
  absoluteStart: number;
  absoluteEnd: number;
  /** Fully decoded source to show in the temp editor. */
  code: string;
  /** Outermost first; write-back encodes in reverse. */
  layers: EncodingLayer[];
  fieldName: string;
  tableName: string;
  profile: 'server' | 'client';
  /** Dotted JSON path when the script came from a JSON string value. */
  keyPath?: string;
}

interface Frame {
  text: string;
  offset: number;
  /** Maps an offset in `text` to an absolute offset in the host document. */
  toAbsolute: (offset: number) => number;
  layers: EncodingLayer[];
  tableName: string;
}

interface ElementSpan {
  name: string;
  parentName?: string;
  bodyStart: number;
  bodyEnd: number;
}

/**
 * Find the innermost script under `absoluteOffset`, or null when the offset is
 * not over anything that reads as code.
 */
export function detectEmbeddedScriptAtOffset(
  text: string,
  absoluteOffset: number
): EmbeddedScriptHit | null {
  return descend(
    {
      text,
      offset: absoluteOffset,
      toAbsolute: (o) => o,
      layers: [],
      tableName: ''
    },
    0
  );
}

/**
 * Re-apply every layer's encoding, innermost first, producing the exact text to
 * splice over the hit's absolute range.
 */
export function encodeThroughLayers(
  code: string,
  layers: EncodingLayer[]
): { ok: true; text: string } | { ok: false; error: string } {
  let value = code;
  for (let i = layers.length - 1; i >= 0; i--) {
    switch (layers[i].kind) {
      case 'jsWrapper':
        value = `javascript(${value})`;
        break;
      case 'jsonString':
        value = JSON.stringify(value);
        break;
      case 'cdata':
        if (value.includes(']]>')) {
          return {
            ok: false,
            error: 'Replacement would terminate CDATA early (contains "]]>").'
          };
        }
        break;
      case 'xmlDocument':
        break;
      case 'xmlText':
        value = encodeXmlEntities(value);
        break;
    }
  }
  return { ok: true, text: value };
}

function descend(frame: Frame, depth: number): EmbeddedScriptHit | null {
  if (depth > MAX_DEPTH) {
    return null;
  }
  const el = innermostElementAt(frame.text, frame.offset);
  if (!el) {
    return null;
  }

  // Inside a nested payload the table comes from the record_update attribute,
  // which survives markup that confuses tag nesting (sys_ui_page <html> holds
  // Jelly with unclosed tags). Fall back to the enclosing element otherwise.
  const tableName = frame.tableName || el.parentName || '';
  const layers = [...frame.layers];
  const bodyRaw = frame.text.slice(el.bodyStart, el.bodyEnd);

  let decoded: string;
  let offsetInDecoded: number;
  let toAbsolute: (offset: number) => number;

  // Anchored: the body must *be* a CDATA section, not merely contain one. A row
  // element whose children include a CDATA script would otherwise be mistaken
  // for a CDATA leaf and swallow the whole record.
  const cdataMatch = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(bodyRaw);
  const isCdataBody = cdataMatch != null;

  if (cdataMatch) {
    const innerStart =
      el.bodyStart + bodyRaw.indexOf(CDATA_OPEN) + CDATA_OPEN.length;
    decoded = cdataMatch[1];
    offsetInDecoded = frame.offset - innerStart;
    toAbsolute = (o) => frame.toAbsolute(innerStart + o);
    layers.push({ kind: 'cdata', fieldName: el.name });
  } else if (bodyRaw.includes('&')) {
    const map = buildDecodedToRawMap(bodyRaw, decodeXmlEntities);
    if (!map) {
      return null;
    }
    decoded = decodeXmlEntities(bodyRaw);
    const bodyStart = el.bodyStart;
    const rawLength = bodyRaw.length;
    offsetInDecoded = rawOffsetToDecoded(map, frame.offset - bodyStart);
    toAbsolute = (o) =>
      frame.toAbsolute(bodyStart + (o < map.length ? map[o] : rawLength));
    layers.push({ kind: 'xmlText', fieldName: el.name });
  } else {
    decoded = bodyRaw;
    const bodyStart = el.bodyStart;
    offsetInDecoded = frame.offset - bodyStart;
    toAbsolute = (o) => frame.toAbsolute(bodyStart + o);
    layers.push({ kind: 'xmlText', fieldName: el.name });
  }

  if (offsetInDecoded < 0) {
    return null;
  }

  // A nested record_update document (customer-update <payload>): recurse so the
  // real script field inside it becomes the innermost layer.
  if (looksLikeXmlDocument(decoded)) {
    return descend(
      {
        text: decoded,
        offset: offsetInDecoded,
        toAbsolute,
        layers: [...layers, { kind: 'xmlDocument' }],
        tableName: recordUpdateTable(decoded) ?? tableName
      },
      depth + 1
    );
  }

  const trimmed = decoded.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const token = findStringTokenAt(decoded, offsetInDecoded);
    if (!token) {
      return null;
    }
    return finish(
      token.value,
      toAbsolute(token.tokenStart),
      toAbsolute(token.tokenEnd),
      [...layers, { kind: 'jsonString' }],
      el.name,
      tableName,
      token.keyPath
    );
  }

  // Landing between child elements means the offset is on structure, not on a
  // value. Angle-bracket soup can parse as JavaScript comparisons and regex
  // literals, so this has to be rejected before the likeness test sees it.
  // CDATA is exempt: it exists to hold text with angle brackets, and scripts
  // there legitimately build HTML strings.
  if (!isCdataBody && /<\/[A-Za-z_][\w.:-]*\s*>/.test(decoded)) {
    return null;
  }

  return finish(
    decoded,
    toAbsolute(0),
    toAbsolute(decoded.length),
    layers,
    el.name,
    tableName
  );
}

function recordUpdateTable(xml: string): string | undefined {
  return /<record_update\b[^>]*\btable="([^"]+)"/i.exec(xml)?.[1];
}

function finish(
  value: string,
  absoluteStart: number,
  absoluteEnd: number,
  layers: EncodingLayer[],
  fieldName: string,
  tableName: string,
  keyPath?: string
): EmbeddedScriptHit | null {
  const { code, hadWrapper } = stripJavascriptWrapper(value);
  if (!looksLikeJavaScript(code).ok) {
    return null;
  }
  return {
    absoluteStart,
    absoluteEnd,
    code,
    layers: hadWrapper ? [...layers, { kind: 'jsWrapper' }] : layers,
    fieldName,
    tableName,
    profile: resolveScriptProfile(tableName, fieldName),
    keyPath
  };
}

/**
 * Deepest element whose body contains `offset`. Closing tags are seen
 * innermost-first in well-formed XML, so the first containing close wins.
 */
function innermostElementAt(text: string, offset: number): ElementSpan | null {
  const tagRe =
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;
  const stack: { name: string; bodyStart: number; parentName?: string }[] = [];
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(text)) !== null) {
    if (m[1] != null) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name !== m[1]) {
          continue;
        }
        const open = stack[i];
        const bodyEnd = m.index;
        if (offset >= open.bodyStart && offset <= bodyEnd) {
          return {
            name: open.name,
            parentName: open.parentName,
            bodyStart: open.bodyStart,
            bodyEnd
          };
        }
        stack.length = i;
        break;
      }
      continue;
    }
    // The attribute run can swallow a trailing slash, so test the whole match
    // rather than the optional group: an unpopped <messages/> would make every
    // later element look like its child.
    if (m[2] == null || m[0].endsWith('/>')) {
      continue;
    }
    stack.push({
      name: m[2],
      bodyStart: tagRe.lastIndex,
      parentName: stack.length > 0 ? stack[stack.length - 1].name : undefined
    });
  }
  return null;
}

function looksLikeXmlDocument(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<')) {
    return false;
  }
  return /^<\?xml\b/i.test(trimmed) || /^<record_update\b/i.test(trimmed);
}

/**
 * Largest decoded index whose raw start is at or before `rawOffset`.
 */
function rawOffsetToDecoded(decodedToRaw: number[], rawOffset: number): number {
  let best = -1;
  for (let i = 0; i < decodedToRaw.length; i++) {
    if (decodedToRaw[i] === rawOffset) {
      return i;
    }
    if (decodedToRaw[i] > rawOffset) {
      break;
    }
    best = i;
  }
  return best;
}

interface StringToken {
  value: string;
  keyPath: string;
  /** Offsets of the token including its quotes. */
  tokenStart: number;
  tokenEnd: number;
}

function findStringTokenAt(json: string, offset: number): StringToken | null {
  let currentProperty: string | null = null;
  const pathStack: string[] = [];
  let objectDepth = 0;
  let arrayDepth = 0;
  let result: StringToken | null = null;

  const visitor: JSONVisitor = {
    onObjectBegin: () => {
      objectDepth++;
    },
    onObjectProperty: (property: string) => {
      const target = objectDepth - 1 + arrayDepth;
      while (pathStack.length > target) {
        pathStack.pop();
      }
      currentProperty = property;
      pathStack.push(property);
    },
    onObjectEnd: () => {
      pathStack.pop();
      objectDepth--;
      currentProperty = null;
    },
    onArrayBegin: () => {
      arrayDepth++;
      pathStack.push('[0]');
    },
    onArrayEnd: () => {
      while (
        pathStack.length > 0 &&
        pathStack[pathStack.length - 1].startsWith('[')
      ) {
        pathStack.pop();
      }
      arrayDepth--;
    },
    onLiteralValue: (value: unknown, valueOffset: number, valueLength: number) => {
      if (result || typeof value !== 'string' || !currentProperty) {
        return;
      }
      if (offset >= valueOffset && offset <= valueOffset + valueLength) {
        result = {
          value,
          keyPath: pathStack.join('.'),
          tokenStart: valueOffset,
          tokenEnd: valueOffset + valueLength
        };
      }
    },
    onSeparator: (sep: string) => {
      if (sep !== ',' || arrayDepth === 0 || pathStack.length === 0) {
        return;
      }
      const last = pathStack[pathStack.length - 1];
      if (last.startsWith('[')) {
        pathStack[pathStack.length - 1] = `[${
          Number.parseInt(last.slice(1, -1), 10) + 1
        }]`;
      }
    }
  };

  visit(json, visitor);
  return result;
}
