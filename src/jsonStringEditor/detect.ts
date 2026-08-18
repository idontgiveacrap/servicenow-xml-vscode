import * as crypto from 'node:crypto';
import type { JSONVisitor } from 'jsonc-parser/lib/esm/main.js';
import { visit } from 'jsonc-parser/lib/esm/main.js';
import {
  decodeXmlEntities,
  extractRowElement,
  isPrimaryAction,
  offsetToPosition,
  parseSnXml
} from '../parseSnXml';
import type { EmbeddedFieldHit, ParsedDocument, RecordRow } from '../kinds/types';
import { buildDecodedToRawMap, stripJavascriptWrapper } from './escape';

export interface JsonStringHit {
  hostPath: string;
  stableHostId: string;
  fieldName: string;
  keyPath: string;
  draftKey: string;
  /** Absolute offsets of the JSON string token (including quotes) in the host document. */
  absoluteStart: number;
  absoluteEnd: number;
  /** Offsets of the token within the field body in *raw* (on-disk) field content. */
  rawStartInField: number;
  rawEndInField: number;
  field: EmbeddedFieldHit;
  unescapedValue: string;
  /** Source shown in the temp editor (wrapper stripped when present). */
  editorCode: string;
  hadJavascriptWrapper: boolean;
  hostVersion: number;
  tableName: string;
}

interface JsonFieldRegion {
  field: EmbeddedFieldHit;
  tableName: string;
}

/**
 * Collect JSON embedded fields from a document, including customer-update payloads.
 */
export function collectJsonFields(doc: ParsedDocument): JsonFieldRegion[] {
  const out: JsonFieldRegion[] = [];
  for (const row of doc.rows) {
    for (const field of row.embeddedFields) {
      if (field.language !== 'json') {
        continue;
      }
      const trimmed = field.decodedContent.trim();
      if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
        continue;
      }
      out.push({ field, tableName: row.tableName });
    }
    if (row.tableName === 'sys_update_xml') {
      out.push(...collectPayloadJsonFields(doc, row));
    }
  }
  return out;
}

/**
 * Detect an eligible JSON string script at the given absolute document offset.
 */
export function detectJsonStringAtOffset(
  text: string,
  absoluteOffset: number,
  hostPath: string,
  hostVersion: number,
  stableHostId?: string
): JsonStringHit | null {
  const doc = parseSnXml(text, hostPath);
  if (!doc.wellFormed && doc.rows.length === 0) {
    return null;
  }

  const fields = collectJsonFields(doc);
  const region = fields.find(
    (f) =>
      absoluteOffset >= f.field.bodyStartOffset &&
      absoluteOffset < f.field.bodyEndOffset
  );
  if (!region) {
    return null;
  }

  const { field } = region;
  const decoded = field.decodedContent;
  const offsetInDecoded = absoluteOffset - field.bodyStartOffset;

  // When entity-encoded, absoluteOffset is in raw space — map to decoded.
  let decodedOffset = offsetInDecoded;
  let decodedToRaw: number[] | null = null;
  if (field.content !== field.decodedContent) {
    decodedToRaw = buildDecodedToRawMap(field.content, decodeXmlEntities);
    if (!decodedToRaw) {
      return null;
    }
    decodedOffset = rawOffsetToDecoded(decodedToRaw, offsetInDecoded);
    if (decodedOffset < 0) {
      return null;
    }
  }

  const found = findStringLiteralAtDecodedOffset(decoded, decodedOffset);
  if (!found) {
    return null;
  }
  if (!isEligibleScriptString(found.propertyName, found.unescapedValue)) {
    return null;
  }

  let rawStartInField = found.tokenStart;
  let rawEndInField = found.tokenEnd;
  if (decodedToRaw) {
    const mapped = mapTokenViaDecodedToRaw(
      decodedToRaw,
      found.tokenStart,
      found.tokenEnd,
      field.content.length
    );
    if (!mapped) {
      return null;
    }
    rawStartInField = mapped.rawStart;
    rawEndInField = mapped.rawEnd;
  }

  const { code, hadWrapper } = stripJavascriptWrapper(found.unescapedValue);
  const id = stableHostId ?? hostPath;
  const draftKey = makeDraftKey(id, field.fieldName, found.keyPath);

  return {
    hostPath,
    stableHostId: id,
    fieldName: field.fieldName,
    keyPath: found.keyPath,
    draftKey,
    absoluteStart: field.bodyStartOffset + rawStartInField,
    absoluteEnd: field.bodyStartOffset + rawEndInField,
    rawStartInField,
    rawEndInField,
    field,
    unescapedValue: found.unescapedValue,
    editorCode: code,
    hadJavascriptWrapper: hadWrapper,
    hostVersion,
    tableName: region.tableName
  };
}

/**
 * Re-find a string by field name + key path (for stale host write-back).
 */
export function detectJsonStringByKeyPath(
  text: string,
  hostPath: string,
  hostVersion: number,
  fieldName: string,
  keyPath: string,
  stableHostId?: string
): JsonStringHit | null {
  const doc = parseSnXml(text, hostPath);
  const fields = collectJsonFields(doc).filter((f) => f.field.fieldName === fieldName);
  for (const region of fields) {
    const hit = findStringByKeyPath(region, keyPath, hostPath, hostVersion, stableHostId);
    if (hit) {
      return hit;
    }
  }
  return null;
}

/**
 * Hash identity for a JSON string draft.
 */
export function makeDraftKey(
  stableHostId: string,
  fieldName: string,
  keyPath: string
): string {
  const material = `${stableHostId}::${fieldName}::${keyPath}`;
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 24);
}

/**
 * Eligible when value is javascript(…) or property name ends with Script.
 */
export function isEligibleScriptString(
  propertyName: string,
  unescapedValue: string
): boolean {
  if (/Script$/i.test(propertyName)) {
    return true;
  }
  return /^\s*javascript\(/.test(unescapedValue);
}

function collectPayloadJsonFields(
  doc: ParsedDocument,
  row: RecordRow
): JsonFieldRegion[] {
  const rowXml = doc.text.slice(row.startOffset, row.endOffset);
  const payloadEl = extractRowElement(rowXml, 'payload');
  if (!payloadEl) {
    return [];
  }
  const payload = payloadEl.isCdata
    ? payloadEl.content
    : decodeXmlEntities(payloadEl.content);
  if (!payload.trim()) {
    return [];
  }

  const cdataToken = '<![CDATA[';
  const payloadTag = rowXml.indexOf('<payload');
  let bodyAbs = row.startOffset;
  if (payloadEl.isCdata) {
    const cdataAt = rowXml.indexOf(cdataToken, payloadTag >= 0 ? payloadTag : 0);
    if (cdataAt >= 0) {
      bodyAbs = row.startOffset + cdataAt + cdataToken.length;
    }
  } else if (payloadTag >= 0) {
    const openEnd = rowXml.indexOf('>', payloadTag);
    if (openEnd >= 0) {
      bodyAbs = row.startOffset + openEnd + 1;
    }
  }

  const inner = parseSnXml(payload);
  if (!inner.wellFormed) {
    return [];
  }

  const out: JsonFieldRegion[] = [];
  for (const innerRow of inner.rows) {
    if (!isPrimaryAction(innerRow.action) && !innerRow.sysId) {
      continue;
    }
    for (const field of innerRow.embeddedFields) {
      if (field.language !== 'json') {
        continue;
      }
      const trimmed = field.decodedContent.trim();
      if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
        continue;
      }
      const absStart = bodyAbs + field.bodyStartOffset;
      const absEnd = bodyAbs + field.bodyEndOffset;
      const pos = offsetToPosition(doc.text, absStart);
      out.push({
        field: {
          ...field,
          bodyStartOffset: absStart,
          bodyEndOffset: absEnd,
          bodyStartLine: pos.line,
          bodyStartCharacter: pos.character
        },
        tableName: innerRow.tableName
      });
    }
  }
  return out;
}

function findStringLiteralAtDecodedOffset(
  decoded: string,
  decodedOffset: number
): {
  propertyName: string;
  keyPath: string;
  tokenStart: number;
  tokenEnd: number;
  unescapedValue: string;
} | null {
  let currentProperty: string | null = null;
  const pathStack: string[] = [];
  let currentDepth = 0;
  let arrayDepth = 0;
  let result: {
    propertyName: string;
    keyPath: string;
    tokenStart: number;
    tokenEnd: number;
    unescapedValue: string;
  } | null = null;

  const visitor: JSONVisitor = {
    onObjectBegin: () => {
      currentDepth++;
    },
    onObjectProperty: (property: string) => {
      const targetStackLength = currentDepth - 1 + arrayDepth;
      while (pathStack.length > targetStackLength) {
        pathStack.pop();
      }
      currentProperty = property;
      pathStack.push(property);
    },
    onObjectEnd: () => {
      if (pathStack.length > 0) {
        pathStack.pop();
      }
      currentDepth--;
      currentProperty = null;
    },
    onArrayBegin: () => {
      arrayDepth++;
      pathStack.push('[0]');
    },
    onArrayEnd: () => {
      while (pathStack.length > 0 && pathStack[pathStack.length - 1].startsWith('[')) {
        pathStack.pop();
      }
      arrayDepth--;
    },
    onLiteralValue: (value: unknown, valueOffset: number, valueLength: number) => {
      if (typeof value !== 'string' || !currentProperty || result) {
        return;
      }
      if (
        decodedOffset >= valueOffset &&
        decodedOffset <= valueOffset + valueLength
      ) {
        result = {
          propertyName: currentProperty,
          keyPath: pathStack.join('.'),
          tokenStart: valueOffset,
          tokenEnd: valueOffset + valueLength,
          unescapedValue: value
        };
      }
    },
    onSeparator: (sep: string) => {
      if (sep === ',' && arrayDepth > 0 && pathStack.length > 0) {
        const lastItem = pathStack[pathStack.length - 1];
        if (lastItem.startsWith('[')) {
          const currentIndex = Number.parseInt(lastItem.slice(1, -1), 10);
          pathStack[pathStack.length - 1] = `[${currentIndex + 1}]`;
        }
      }
    }
  };

  visit(decoded, visitor);
  return result;
}

function findStringByKeyPath(
  region: JsonFieldRegion,
  keyPath: string,
  hostPath: string,
  hostVersion: number,
  stableHostId?: string
): JsonStringHit | null {
  const { field } = region;
  const decoded = field.decodedContent;
  type Found = {
    propertyName: string;
    keyPath: string;
    tokenStart: number;
    tokenEnd: number;
    unescapedValue: string;
  };
  const box: { found: Found | null } = { found: null };

  let currentProperty: string | null = null;
  const pathStack: string[] = [];
  let currentDepth = 0;
  let arrayDepth = 0;

  const visitor: JSONVisitor = {
    onObjectBegin: () => {
      currentDepth++;
    },
    onObjectProperty: (property: string) => {
      const targetStackLength = currentDepth - 1 + arrayDepth;
      while (pathStack.length > targetStackLength) {
        pathStack.pop();
      }
      currentProperty = property;
      pathStack.push(property);
    },
    onObjectEnd: () => {
      if (pathStack.length > 0) {
        pathStack.pop();
      }
      currentDepth--;
      currentProperty = null;
    },
    onArrayBegin: () => {
      arrayDepth++;
      pathStack.push('[0]');
    },
    onArrayEnd: () => {
      while (pathStack.length > 0 && pathStack[pathStack.length - 1].startsWith('[')) {
        pathStack.pop();
      }
      arrayDepth--;
    },
    onLiteralValue: (value: unknown, valueOffset: number, valueLength: number) => {
      if (typeof value !== 'string' || !currentProperty || box.found) {
        return;
      }
      if (pathStack.join('.') === keyPath) {
        box.found = {
          propertyName: currentProperty,
          keyPath,
          tokenStart: valueOffset,
          tokenEnd: valueOffset + valueLength,
          unescapedValue: value
        };
      }
    },
    onSeparator: (sep: string) => {
      if (sep === ',' && arrayDepth > 0 && pathStack.length > 0) {
        const lastItem = pathStack[pathStack.length - 1];
        if (lastItem.startsWith('[')) {
          const currentIndex = Number.parseInt(lastItem.slice(1, -1), 10);
          pathStack[pathStack.length - 1] = `[${currentIndex + 1}]`;
        }
      }
    }
  };

  visit(decoded, visitor);
  const found = box.found;
  if (!found || !isEligibleScriptString(found.propertyName, found.unescapedValue)) {
    return null;
  }

  let rawStartInField = found.tokenStart;
  let rawEndInField = found.tokenEnd;
  if (field.content !== field.decodedContent) {
    const decodedToRaw = buildDecodedToRawMap(field.content, decodeXmlEntities);
    if (!decodedToRaw) {
      return null;
    }
    const mapped = mapTokenViaDecodedToRaw(
      decodedToRaw,
      found.tokenStart,
      found.tokenEnd,
      field.content.length
    );
    if (!mapped) {
      return null;
    }
    rawStartInField = mapped.rawStart;
    rawEndInField = mapped.rawEnd;
  }

  const { code, hadWrapper } = stripJavascriptWrapper(found.unescapedValue);
  const id = stableHostId ?? hostPath;
  return {
    hostPath,
    stableHostId: id,
    fieldName: field.fieldName,
    keyPath: found.keyPath,
    draftKey: makeDraftKey(id, field.fieldName, found.keyPath),
    absoluteStart: field.bodyStartOffset + rawStartInField,
    absoluteEnd: field.bodyStartOffset + rawEndInField,
    rawStartInField,
    rawEndInField,
    field,
    unescapedValue: found.unescapedValue,
    editorCode: code,
    hadJavascriptWrapper: hadWrapper,
    hostVersion,
    tableName: region.tableName
  };
}

function rawOffsetToDecoded(decodedToRaw: number[], rawOffset: number): number {
  // Prefer the decoded index whose raw start equals rawOffset; else last where rawStart <= rawOffset.
  let best = -1;
  for (let i = 0; i < decodedToRaw.length; i++) {
    if (decodedToRaw[i] === rawOffset) {
      return i;
    }
    if (decodedToRaw[i] <= rawOffset) {
      best = i;
    }
  }
  return best;
}

function mapTokenViaDecodedToRaw(
  decodedToRaw: number[],
  tokenStart: number,
  tokenEnd: number,
  rawLength: number
): { rawStart: number; rawEnd: number } | null {
  if (tokenStart < 0 || tokenEnd > decodedToRaw.length || tokenStart >= tokenEnd) {
    return null;
  }
  const rawStart = decodedToRaw[tokenStart];
  const rawEnd =
    tokenEnd === decodedToRaw.length ? rawLength : decodedToRaw[tokenEnd];
  if (rawStart == null || rawEnd == null || rawEnd < rawStart) {
    return null;
  }
  return { rawStart, rawEnd };
}
