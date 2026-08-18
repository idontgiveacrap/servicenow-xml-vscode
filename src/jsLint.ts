import type { Linter as LinterType } from 'eslint';
import { ScriptRegion, mapScriptOffsetToXml } from './scriptRegions';
import { SnDiagnostic } from './kinds/types';

const SERVER_GLOBALS: Record<string, 'readonly' | 'writable'> = {
  gs: 'readonly',
  GlideRecord: 'readonly',
  GlideAggregate: 'readonly',
  GlideDateTime: 'readonly',
  GlideDate: 'readonly',
  GlideTime: 'readonly',
  GlideElement: 'readonly',
  GlideUser: 'readonly',
  GlideSysAttachment: 'readonly',
  Class: 'readonly',
  current: 'readonly',
  previous: 'readonly',
  g_scratchpad: 'writable',
  workflow: 'readonly',
  activity: 'readonly',
  sn_ws: 'readonly',
  sn_fd: 'readonly',
  sn_auth: 'readonly',
  RP: 'readonly',
  AbstractAjaxProcessor: 'readonly'
};

const CLIENT_GLOBALS: Record<string, 'readonly' | 'writable'> = {
  g_form: 'readonly',
  g_user: 'readonly',
  g_list: 'readonly',
  g_scratchpad: 'writable',
  gel: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  console: 'readonly',
  document: 'readonly',
  window: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  jQuery: 'readonly',
  $: 'readonly',
  angular: 'readonly',
  // UX client script include wrapper
  imports: 'readonly',
  api: 'readonly'
};

/** Characters that force entity encoding (or break CDATA) in XML text nodes. */
const XML_TEXT_ESCAPE_RE = /[&<]|[^\t\n\r\x20-\x7E]/;

let linter: LinterType | undefined;

/**
 * Load ESLint only when an embedded JavaScript region actually needs linting.
 */
function getLinter(): LinterType {
  if (!linter) {
    // eslint is deliberately required lazily to keep XML-only activation lighter.
    const { Linter } = require('eslint') as typeof import('eslint');
    linter = new Linter();
  }
  return linter;
}

function configFor(profile: 'server' | 'client'): LinterType.Config {
  const globals =
    profile === 'client'
      ? { ...CLIENT_GLOBALS }
      : { ...SERVER_GLOBALS, ...CLIENT_GLOBALS };

  return {
    env: {
      es2022: true
    },
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: 'script'
    },
    globals,
    rules: {
      'no-undef': 'error',
      // ServiceNow invokes script fields through platform entry points, so the
      // declarations the platform calls look unused inside the field body:
      // `handler` in a UX client script, `onBefore` in a business rule, the
      // `var X = Class.create()` a Script Include exports. Those are top-level,
      // so `vars: 'local'` keeps them quiet while still flagging dead locals.
      // Parameter lists are platform-dictated too (`handler({api, event,
      // helpers, imports})`), hence `args: 'none'`.
      'no-unused-vars': [
        'warn',
        {
          vars: 'local',
          args: 'none',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_'
        }
      ],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'warn',
      'no-empty': 'warn',
      'valid-typeof': 'error',
      'use-isnan': 'error',
      eqeqeq: ['warn', 'smart'],
      semi: 'off',
      quotes: 'off',
      indent: 'off'
    }
  } as LinterType.Config;
}

/**
 * Map a 0-based offset in entity-decoded script text back into the raw XML body.
 */
function decodedOffsetToRawOffset(encoded: string, decodedOffset: number): number {
  if (decodedOffset <= 0) {
    return 0;
  }
  let decodedIndex = 0;
  let encodedIndex = 0;
  while (encodedIndex < encoded.length && decodedIndex < decodedOffset) {
    if (encoded.charCodeAt(encodedIndex) === 38 /* & */) {
      const semi = encoded.indexOf(';', encodedIndex + 1);
      if (semi === -1) {
        encodedIndex += 1;
        decodedIndex += 1;
        continue;
      }
      // One entity → one (or rarely more) decoded code unit(s); treat as one step for BMP entities.
      const entity = encoded.slice(encodedIndex, semi + 1);
      const piece = entity.replace(
        /&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/i,
        (match, decimal: string | undefined, hex: string | undefined) => {
          if (decimal || hex) {
            const codePoint = Number.parseInt(decimal ?? hex ?? '', decimal ? 10 : 16);
            return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
          }
          switch (match.toLowerCase()) {
            case '&amp;':
              return '&';
            case '&lt;':
              return '<';
            case '&gt;':
              return '>';
            case '&quot;':
              return '"';
            case '&apos;':
              return "'";
            default:
              return match;
          }
        }
      );
      decodedIndex += piece.length;
      encodedIndex = semi + 1;
    } else {
      encodedIndex += 1;
      decodedIndex += 1;
    }
  }
  return encodedIndex;
}

/**
 * Map ESLint line/column (in decoded script space) to host XML coordinates.
 */
function mapDecodedLintPosToXml(
  region: ScriptRegion,
  lineInDecoded: number,
  columnInDecoded: number
): { line: number; character: number } {
  const decoded = region.decodedContent;
  let offsetInDecoded = 0;
  let line = 0;
  while (line < lineInDecoded && offsetInDecoded < decoded.length) {
    const nl = decoded.indexOf('\n', offsetInDecoded);
    if (nl === -1) {
      offsetInDecoded = decoded.length;
      break;
    }
    offsetInDecoded = nl + 1;
    line++;
  }
  offsetInDecoded += columnInDecoded;

  if (region.content === decoded) {
    return mapScriptOffsetToXml(region, lineInDecoded, columnInDecoded);
  }

  const rawOffset = decodedOffsetToRawOffset(region.content, offsetInDecoded);
  let xmlLine = region.bodyStartLine;
  let xmlChar = region.bodyStartCharacter;
  for (let i = 0; i < rawOffset && i < region.content.length; i++) {
    if (region.content.charCodeAt(i) === 10) {
      xmlLine++;
      xmlChar = 0;
    } else {
      xmlChar++;
    }
  }
  return { line: xmlLine, character: xmlChar };
}

/**
 * Warn when script text contains characters that force XML escaping, or break CDATA.
 */
function encodingDiagnostics(region: ScriptRegion): SnDiagnostic[] {
  const decoded = region.decodedContent;
  if (!decoded.trim()) {
    return [];
  }
  const start = mapDecodedLintPosToXml(region, 0, 0);

  if (region.isCdata) {
    if (decoded.includes(']]>')) {
      return [
        {
          message: `<${region.fieldName}> CDATA body contains "]]>", which terminates CDATA early.`,
          severity: 'error',
          line: start.line,
          character: start.character,
          code: 'script-cdata-terminator'
        }
      ];
    }
    return [];
  }

  if (!XML_TEXT_ESCAPE_RE.test(decoded)) {
    return [];
  }

  return [
    {
      message: `<${region.fieldName}> contains characters that require XML entity encoding outside CDATA (&, <, or non-ASCII such as emoji). Prefer wrapping the field in CDATA.`,
      severity: 'warning',
      line: start.line,
      character: start.character,
      code: 'script-needs-xml-encoding'
    }
  ];
}

/**
 * Lint extracted script regions and return diagnostics in host XML coordinates.
 * Always lints entity-decoded text; maps positions back through entity spans when needed.
 */
export function lintScriptRegions(regions: ScriptRegion[]): SnDiagnostic[] {
  const out: SnDiagnostic[] = [];
  const engine = getLinter();

  for (const region of regions) {
    out.push(...encodingDiagnostics(region));

    const config = configFor(region.profile);
    const source = region.decodedContent;
    let messages: LinterType.LintMessage[];
    try {
      messages = engine.verify(source, config, {
        filename: `${region.tableName}.${region.fieldName}.js`
      });
    } catch (err) {
      const pos = mapDecodedLintPosToXml(region, 0, 0);
      out.push({
        message: `ESLint failed on <${region.fieldName}>: ${
          err instanceof Error ? err.message : String(err)
        }`,
        severity: 'error',
        line: pos.line,
        character: pos.character,
        code: 'eslint-crash'
      });
      continue;
    }

    for (const msg of messages) {
      // ESLint lines/columns are 1-based
      const lineInScript = Math.max(0, (msg.line ?? 1) - 1);
      const colInScript = Math.max(0, (msg.column ?? 1) - 1);
      const start = mapDecodedLintPosToXml(region, lineInScript, colInScript);

      let endLine = start.line;
      let endCharacter = start.character + 1;
      if (msg.endLine != null && msg.endColumn != null) {
        const end = mapDecodedLintPosToXml(
          region,
          Math.max(0, msg.endLine - 1),
          Math.max(0, msg.endColumn - 1)
        );
        endLine = end.line;
        endCharacter = end.character;
      }

      out.push({
        message: `[${region.fieldName}] ${msg.message}${msg.ruleId ? ` (${msg.ruleId})` : ''}`,
        severity: msg.severity === 2 ? 'error' : 'warning',
        line: start.line,
        character: start.character,
        endLine,
        endCharacter,
        code: msg.ruleId ?? 'eslint'
      });
    }
  }

  return out;
}
