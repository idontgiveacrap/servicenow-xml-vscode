import { SnDiagnostic } from './kinds/types';
import { JsonRegion, mapScriptOffsetToXml } from './scriptRegions';

/**
 * Validate embedded JSON field bodies; map parse errors onto the host XML.
 */
export function lintJsonRegions(regions: JsonRegion[]): SnDiagnostic[] {
  const out: SnDiagnostic[] = [];

  for (const region of regions) {
    const text = region.decodedContent.trim();
    try {
      JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const posMatch = message.match(/position\s+(\d+)/i);
      const lineColMatch = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);

      let lineIn = 0;
      let colIn = 0;
      if (lineColMatch) {
        lineIn = Math.max(0, parseInt(lineColMatch[1], 10) - 1);
        colIn = Math.max(0, parseInt(lineColMatch[2], 10) - 1);
      } else if (posMatch) {
        const abs = Math.min(parseInt(posMatch[1], 10), Math.max(0, text.length - 1));
        const mapped = offsetInString(text, abs);
        lineIn = mapped.line;
        colIn = mapped.character;
      }

      // Map using raw field content when it matches decoded (typical for data exports).
      // For entity-encoded UX fields, positions are approximate on the opening of the field.
      const mapRegion =
        region.content.trim() === text
          ? {
              ...region,
              content: text,
              bodyStartOffset:
                region.bodyStartOffset + Math.max(0, region.content.indexOf(text)),
              bodyStartCharacter:
                region.bodyStartLine === offsetInString(region.content, Math.max(0, region.content.indexOf(text))).line
                  ? region.bodyStartCharacter + Math.max(0, region.content.indexOf(text))
                  : region.bodyStartCharacter
            }
          : region;

      const start = mapScriptOffsetToXml(mapRegion, lineIn, colIn);

      out.push({
        message: `[${region.fieldName}] Invalid JSON: ${message}`,
        severity: 'error',
        line: start.line,
        character: start.character,
        code: 'json-parse'
      });
    }
  }

  return out;
}

function offsetInString(
  text: string,
  offset: number
): { line: number; character: number } {
  let line = 0;
  let lastNl = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, character: offset - lastNl - 1 };
}
