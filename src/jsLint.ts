import type { Linter as LinterType, Rule } from 'eslint';
import { ScriptRegion, mapScriptOffsetToXml } from './scriptRegions';
import { SnDiagnostic } from './kinds/types';
import { JavaScriptSupport } from './javascriptSupport';

const SERVER_GLOBALS: Record<string, 'readonly' | 'writable'> = {
  // Core scripting entry point
  gs: 'readonly',
  Class: 'readonly',
  SNC: 'readonly',

  // Query / record APIs
  GlideRecord: 'readonly',
  GlideRecordSecure: 'readonly',
  GlideAggregate: 'readonly',
  GlideQuery: 'readonly',
  GlideQueryCondition: 'readonly',
  GlideFilter: 'readonly',
  GlideElement: 'readonly',
  GlideTableHierarchy: 'readonly',
  GlideDBFunctionBuilder: 'readonly',

  // Date / time
  GlideDateTime: 'readonly',
  GlideDate: 'readonly',
  GlideTime: 'readonly',
  GlideDuration: 'readonly',
  GlideSchedule: 'readonly',
  GlideScheduleDateTime: 'readonly',

  // Session / security
  GlideSystem: 'readonly',
  GlideSession: 'readonly',
  GlideUser: 'readonly',
  GlideImpersonate: 'readonly',
  GlideSecurityManager: 'readonly',
  GlideEncrypter: 'readonly',
  GlideDigest: 'readonly',

  // Utility
  GlideSysAttachment: 'readonly',
  GlideStringUtil: 'readonly',
  GlideXMLUtil: 'readonly',
  GlideProperties: 'readonly',
  GlideTemplate: 'readonly',
  GlideURI: 'readonly',
  GlideEmailOutbound: 'readonly',
  GlideTransaction: 'readonly',
  GlideScriptedExtensionPoint: 'readonly',
  GlideSPScriptable: 'readonly',

  // Scoped API namespaces
  sn_ws: 'readonly',
  sn_fd: 'readonly',
  sn_auth: 'readonly',
  sn_sc: 'readonly',
  sn_cmdb: 'readonly',
  sn_impex: 'readonly',
  sn_notification: 'readonly',

  // Rhino/Java bridge; only reachable from global-scope scripts, but scoped
  // exports occasionally still carry legacy code that references it.
  Packages: 'readonly',
  java: 'readonly',

  // Platform-supplied entry-point variables. Which of these is bound depends on
  // the script field (business rule, UI action, notification, scripted REST),
  // and the linter has no per-field binding table, so all are always allowed.
  current: 'readonly',
  previous: 'readonly',
  g_scratchpad: 'writable',
  workflow: 'readonly',
  activity: 'readonly',
  action: 'readonly',
  event: 'readonly',
  producer: 'readonly',
  template: 'readonly',
  email: 'readonly',
  email_action: 'readonly',
  request: 'readonly',
  response: 'readonly',
  RP: 'readonly',
  AbstractAjaxProcessor: 'readonly'
};

const CLIENT_GLOBALS: Record<string, 'readonly' | 'writable'> = {
  // Platform-supplied client variables
  g_form: 'readonly',
  g_user: 'readonly',
  g_list: 'readonly',
  g_scratchpad: 'writable',
  g_navigation: 'readonly',
  g_document: 'readonly',
  g_i18n: 'readonly',
  g_modal: 'readonly',
  g_menu: 'readonly',
  g_service_catalog: 'readonly',

  // Client-side Glide classes. GlideAjax is how client code reaches a
  // client-callable Script Include, so the Script Include name itself is a
  // string argument and never appears as a bare identifier here.
  GlideAjax: 'readonly',
  GlideRecord: 'readonly',
  GlideModal: 'readonly',
  GlideModalForm: 'readonly',
  GlideDialogWindow: 'readonly',
  GlideList2: 'readonly',
  GlideMenu: 'readonly',
  GlideURL: 'readonly',
  GlideForm: 'readonly',
  GlideUser: 'readonly',
  NOW: 'readonly',

  // Service Portal client
  spModal: 'readonly',
  spUtil: 'readonly',

  gel: 'readonly',
  getMessage: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  prompt: 'readonly',
  console: 'readonly',
  document: 'readonly',
  window: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  history: 'readonly',
  top: 'readonly',
  parent: 'readonly',
  fetch: 'readonly',
  CustomEvent: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  jQuery: 'readonly',
  $: 'readonly',
  $j: 'readonly',
  angular: 'readonly',
  // UX client script include wrapper
  imports: 'readonly',
  api: 'readonly'
};

export interface ScriptIncludeScope {
  /** Every active Script Include name in the scope. */
  names: string[];
  /**
   * Names whose `access` is `package_private`, i.e. callable only from their own
   * scope. Absent when the source export omitted the `access` column, which is
   * different from present-but-empty.
   */
  packagePrivate?: string[];
  /** Names reachable from client code through GlideAjax. */
  clientCallable?: string[];
}

interface ScriptIncludeWhitelist {
  version: number;
  /** Scope technical name (api_name prefix) -> Script Includes in that scope. */
  scopes: Record<string, ScriptIncludeScope>;
}

// Required rather than imported so tsc does not infer a literal type for every
// one of the several thousand names; esbuild still inlines the JSON.
const SCRIPT_INCLUDES: ScriptIncludeWhitelist = require('./data/scriptIncludes.json');

/**
 * Server-side globals contributed by the Script Include whitelist.
 *
 * ServiceNow only resolves a Script Include by bare name when it lives in the
 * `global` scope (or in the scope of the script being linted). Everything else
 * is reached as `<scope>.<Name>`, where an undefined-variable error would land
 * on the scope namespace, not the class. So global-scope entries become bare
 * names and every other scope contributes its namespace identifier instead.
 */
function buildScriptIncludeGlobals(): Record<string, 'readonly'> {
  const globals: Record<string, 'readonly'> = {};
  for (const [scope, entry] of Object.entries(SCRIPT_INCLUDES.scopes)) {
    if (scope === 'global') {
      for (const name of entry.names) {
        globals[name] = 'readonly';
      }
    } else {
      globals[scope] = 'readonly';
    }
  }
  return globals;
}

const SCRIPT_INCLUDE_GLOBALS = buildScriptIncludeGlobals();

/** Characters that force entity encoding (or break CDATA) in XML text nodes. */
const XML_TEXT_ESCAPE_RE = /[&<]|[^\t\n\r\x20-\x7E]/;

let linter: LinterType | undefined;

const SERVICENOW_RULES: Record<string, Rule.RuleModule> = {
  'no-hardcoded-sysids': require('eslint-plugin-servicenow/lib/rules/no-hardcoded-sysids'),
  'no-at-method': require('eslint-plugin-servicenow/lib/rules/no-at-method'),
  'no-promise': require('eslint-plugin-servicenow/lib/rules/no-promise'),
  'no-weak-references': require('eslint-plugin-servicenow/lib/rules/no-weak-references'),
  'no-async-await': require('eslint-plugin-servicenow/lib/rules/no-async-await'),
  'no-async-iterators': require('eslint-plugin-servicenow/lib/rules/no-async-iterators'),
  'no-bigint': require('eslint-plugin-servicenow/lib/rules/no-bigint'),
  'no-date-tojson': require('eslint-plugin-servicenow/lib/rules/no-date-tojson'),
  'no-packages-calls': require('eslint-plugin-servicenow/lib/rules/no-packages-calls'),
  'no-private-class-methods': require('eslint-plugin-servicenow/lib/rules/no-private-class-methods'),
  'no-proxy-internal-calls': require('eslint-plugin-servicenow/lib/rules/no-proxy-internal-calls'),
  'no-regexp-lookbehind': require('eslint-plugin-servicenow/lib/rules/no-regexp-lookbehind'),
  'no-setprototypeof': require('eslint-plugin-servicenow/lib/rules/no-setprototypeof'),
  'no-shared-memory-atomics': require('eslint-plugin-servicenow/lib/rules/no-shared-memory-atomics'),
  'no-typed-arrays': require('eslint-plugin-servicenow/lib/rules/no-typed-arrays'),
  'no-optional-catch-binding': require('eslint-plugin-servicenow/lib/rules/no-optional-catch-binding'),
  'dont-use-gr-as-variablename': require('eslint-plugin-servicenow/lib/rules/dont-use-gr-as-variablename'),
  'minimize-gs-log-print': require('eslint-plugin-servicenow/lib/rules/minimize-gs-log-print')
};

const PLATFORM_RULES_ALL_MODES: LinterType.RulesRecord = {
  'servicenow/no-hardcoded-sysids': 'warn',
  'servicenow/no-weak-references': 'warn',
  'servicenow/no-async-iterators': 'warn',
  'servicenow/no-packages-calls': 'error',
  'servicenow/no-private-class-methods': 'error',
  'servicenow/no-proxy-internal-calls': 'warn',
  'servicenow/no-regexp-lookbehind': 'warn',
  'servicenow/no-shared-memory-atomics': 'error'
};

const PLATFORM_RULES_ES5_ONLY: LinterType.RulesRecord = {
  'servicenow/no-at-method': 'warn',
  'servicenow/no-promise': 'warn',
  'servicenow/no-async-await': 'warn',
  'servicenow/no-bigint': 'warn',
  'servicenow/no-date-tojson': 'warn',
  'servicenow/no-setprototypeof': 'error',
  'servicenow/no-typed-arrays': 'error'
};

// Prevent duplicate no-undef reports for names diagnosed by platform rules.
const PLATFORM_FEATURE_GLOBALS: Record<string, 'readonly'> = {
  Promise: 'readonly',
  WeakRef: 'readonly',
  FinalizationRegistry: 'readonly',
  BigInt: 'readonly',
  BigInt64Array: 'readonly',
  BigUint64Array: 'readonly',
  SharedArrayBuffer: 'readonly',
  Atomics: 'readonly',
  Proxy: 'readonly',
  Int8Array: 'readonly',
  Uint8Array: 'readonly',
  Uint8ClampedArray: 'readonly',
  Int16Array: 'readonly',
  Uint16Array: 'readonly',
  Int32Array: 'readonly',
  Uint32Array: 'readonly',
  Float32Array: 'readonly',
  Float64Array: 'readonly',
  DataView: 'readonly'
};

/**
 * Load ESLint only when an embedded JavaScript region actually needs linting.
 */
function getLinter(): LinterType {
  if (!linter) {
    // eslint is deliberately required lazily to keep XML-only activation lighter.
    const { Linter } = require('eslint') as typeof import('eslint');
    linter = new Linter();
    linter.defineRules(
      Object.fromEntries(
        Object.entries(SERVICENOW_RULES).map(([name, rule]) => [
          `servicenow/${name}`,
          rule
        ])
      )
    );
  }
  return linter;
}

const configCache = new Map<string, LinterType.Config>();

/**
 * Build (and cache) the ESLint config for a script profile.
 *
 * Cached because the server globals map carries a few thousand Script Include
 * names and `lintScriptRegions` asks for a config per region.
 */
function configFor(
  profile: 'server' | 'client',
  javascriptSupport: JavaScriptSupport
): LinterType.Config {
  const cacheKey = `${profile}:${javascriptSupport}`;
  const cached = configCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Script Include names come first so the hand-maintained platform lists win
  // if an instance ever ships a Script Include that shadows a Glide API.
  const globals =
    profile === 'client'
      ? { ...PLATFORM_FEATURE_GLOBALS, ...CLIENT_GLOBALS }
      : {
          ...PLATFORM_FEATURE_GLOBALS,
          ...SCRIPT_INCLUDE_GLOBALS,
          ...SERVER_GLOBALS,
          ...CLIENT_GLOBALS
        };
  const platformRules =
    javascriptSupport === 'ES5'
      ? { ...PLATFORM_RULES_ALL_MODES, ...PLATFORM_RULES_ES5_ONLY }
      : PLATFORM_RULES_ALL_MODES;

  const config = {
    env: javascriptSupport === 'ES12' ? { es2022: true } : {},
    parserOptions: {
      ecmaVersion: javascriptSupport === 'ES12' ? 2022 : 5,
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
      indent: 'off',
      ...platformRules
    }
  } as LinterType.Config;

  configCache.set(cacheKey, config);
  return config;
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

    const javascriptSupport = region.javascriptSupport ?? 'ES5';
    const config = configFor(region.profile, javascriptSupport);
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
        message: `[${region.fieldName}] [${javascriptSupport}] ${msg.message}${
          msg.ruleId ? ` (${msg.ruleId})` : ''
        }`,
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
