/**
 * JSON string and javascript() wrapper helpers for embedded JSON script editing.
 */

const JS_WRAPPER_PREFIX = 'javascript(';

/**
 * Escape a string as a JSON string token including surrounding quotes.
 */
export function toJsonStringToken(value: string): string {
  return JSON.stringify(value);
}

/**
 * Unescape the inner contents of a JSON string (no surrounding quotes).
 */
export function unescapeJsonStringContents(inner: string): string {
  return JSON.parse(`"${inner}"`) as string;
}

/**
 * True when the unescaped value is an outer javascript(…) wrapper.
 */
export function hasJavascriptWrapper(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith(JS_WRAPPER_PREFIX) &&
    trimmed.endsWith(')') &&
    trimmed.length > JS_WRAPPER_PREFIX.length + 1
  );
}

/**
 * Strip a single outer javascript(…) wrapper. Returns the inner source and whether
 * a wrapper was present. Uses prefix + final closing paren only (not paren balancing).
 */
export function stripJavascriptWrapper(value: string): {
  code: string;
  hadWrapper: boolean;
} {
  const trimmed = value.trim();
  if (!hasJavascriptWrapper(trimmed)) {
    return { code: value, hadWrapper: false };
  }
  const inner = trimmed.slice(JS_WRAPPER_PREFIX.length, -1);
  return { code: inner, hadWrapper: true };
}

/**
 * Restore an outer javascript(…) wrapper when the original value had one.
 * If the edited code already starts with javascript( and ends with ), leave it.
 */
export function restoreJavascriptWrapper(
  code: string,
  hadWrapper: boolean
): string {
  if (!hadWrapper) {
    return code;
  }
  if (hasJavascriptWrapper(code)) {
    return code.trim();
  }
  return `${JS_WRAPPER_PREFIX}${code})`;
}

/**
 * True when inserting replacement into a CDATA body would terminate CDATA early.
 */
export function wouldBreakCdata(replacement: string): boolean {
  return replacement.includes(']]>');
}

/**
 * Build a decoded→raw offset map for entity-encoded XML text.
 * decodedToRaw[i] is the start index in raw of the character at decoded[i].
 * Returns null if the decode round-trip does not match decodeXmlEntities(raw).
 */
export function buildDecodedToRawMap(
  raw: string,
  decode: (s: string) => string
): number[] | null {
  const decoded = decode(raw);
  const map: number[] = [];
  let ri = 0;
  let di = 0;

  while (ri < raw.length && di < decoded.length) {
    if (raw[ri] === '&') {
      const semi = raw.indexOf(';', ri);
      if (semi < 0) {
        return null;
      }
      const entity = raw.slice(ri, semi + 1);
      const expanded = decode(entity);
      if (!expanded || decoded.slice(di, di + expanded.length) !== expanded) {
        return null;
      }
      for (let k = 0; k < expanded.length; k++) {
        map.push(ri);
      }
      di += expanded.length;
      ri = semi + 1;
      continue;
    }
    if (raw[ri] !== decoded[di]) {
      return null;
    }
    map.push(ri);
    ri++;
    di++;
  }

  if (di !== decoded.length || ri !== raw.length) {
    return null;
  }
  return map;
}

/**
 * Map a [start, end) range in decoded text to [start, end) in raw using decodedToRaw.
 * end is exclusive in decoded space; raw end is exclusive after the last mapped char,
 * or raw.length when end === decoded.length.
 */
export function mapDecodedRangeToRaw(
  decodedToRaw: number[],
  decodedStart: number,
  decodedEnd: number,
  rawLength: number
): { rawStart: number; rawEnd: number } | null {
  if (
    decodedStart < 0 ||
    decodedEnd < decodedStart ||
    decodedEnd > decodedToRaw.length
  ) {
    return null;
  }
  if (decodedStart === decodedEnd) {
    const rawStart =
      decodedStart < decodedToRaw.length
        ? decodedToRaw[decodedStart]
        : rawLength;
    return { rawStart, rawEnd: rawStart };
  }
  const rawStart = decodedToRaw[decodedStart];
  if (decodedEnd === decodedToRaw.length) {
    return { rawStart, rawEnd: rawLength };
  }
  // End is exclusive: raw end is the start of the character at decodedEnd.
  const rawEnd = decodedToRaw[decodedEnd];
  if (rawStart == null || rawEnd == null || rawEnd < rawStart) {
    return null;
  }
  return { rawStart, rawEnd };
}
