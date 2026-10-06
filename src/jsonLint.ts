import { SnDiagnostic } from './kinds/types';
import { mapDecodedLintPosToXml } from './jsLint';
import { JsonRegion } from './scriptRegions';

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

      // Error coordinates are in the trimmed decoded body. Shift them back
      // onto decodedContent, then through the same raw-XML map as JS lint.
      const lead =
        region.decodedContent.length - region.decodedContent.trimStart().length;
      const leadPos = offsetInString(region.decodedContent, lead);
      const start = mapDecodedLintPosToXml(
        region,
        leadPos.line + lineIn,
        lineIn === 0 ? leadPos.character + colIn : colIn
      );

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
