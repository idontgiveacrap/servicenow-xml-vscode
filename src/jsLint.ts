import type { Linter as LinterType, Rule, Scope } from 'eslint';
import { ScriptRegion, mapScriptOffsetToXml } from './scriptRegions';
import { SnDiagnostic } from './kinds/types';
import { JavaScriptSupport } from './javascriptSupport';
import {
  globalsForDeclarations,
  ScopeList,
  ScriptDeclaration,
  scriptDeclarationsKey,
  ScriptIncludeWhitelist
} from './scriptDeclarations';

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

// Required rather than imported so tsc does not infer a literal type for every
// one of the several thousand names; esbuild still inlines the JSON.
const SCRIPT_INCLUDES: ScriptIncludeWhitelist = require('./data/scriptIncludes.json');

// Instance scope list, so a `<scope>.<Name>` namespace resolves even when the
// Script Include whitelist has no record for that scope.
const SCOPES: ScopeList = require('./data/scopes.json');

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
 * Globals reported only when declared at the top level of a script.
 *
 * Whether the platform binds any of these depends on the script field, and code
 * rebinds them in an inner scope on purpose: `handler({api, event, imports})` in
 * a UX client script, a helper that takes `current` as a parameter, the
 * `(function ($) { ... })(jQuery)` wrapper. A top-level declaration still
 * replaces the platform value for the whole script.
 */
const SHADOW_TOP_LEVEL_ONLY: string[] = [
  // Platform-supplied entry-point variables
  'current',
  'previous',
  'g_scratchpad',
  'workflow',
  'activity',
  'action',
  'event',
  'producer',
  'template',
  'email',
  'email_action',
  'request',
  'response',
  'RP',
  'g_form',
  'g_user',
  'g_list',
  'g_navigation',
  'g_document',
  'g_i18n',
  'g_modal',
  'g_menu',
  'g_service_catalog',
  'imports',
  'api',

  // Ambient names that wrapper idioms routinely rebind
  'window',
  'document',
  'location',
  'navigator',
  'history',
  'top',
  'parent',
  'jQuery',
  '$',
  '$j',
  'angular'
];

const SHADOWED_PLATFORM_GLOBAL_RULE = 'servicenow-xml/no-shadowed-platform-global';

/**
 * ESLint tags every global that came from configuration — our `globals` map,
 * the env, and the ecmaVersion builtins — with an implicit setting, and leaves
 * it undefined for names the script itself introduces. Core `no-redeclare`
 * reads the same field; @types/eslint does not declare it.
 */
type ConfiguredGlobal = Scope.Variable & {
  eslintImplicitGlobalSetting?: 'readonly' | 'writable' | 'off';
};

/**
 * Report declarations of names the platform binds at runtime, such as
 * `var gs = ...` or `var GlideRecord = ...`, which shadow the platform value.
 *
 * Neither core rule can do this. `no-redeclare` with `builtinGlobals` treats
 * every name in `globals` as built-in, so it reports each Script Include's own
 * `var Name = Class.create()`; `no-shadow` only walks the child scopes of the
 * global scope, so it never sees a top-level declaration. `allow` carries the
 * names that are globals for a reason other than the platform binding them, and
 * `topLevelOnly` the ones an inner scope may rebind.
 */
const noShadowedPlatformGlobal: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow declaring a variable that the ServiceNow platform already provides'
    },
    messages: {
      shadowed:
        "'{{name}}' is supplied by the platform at runtime; declaring it here shadows the platform value."
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: { type: 'array', items: { type: 'string' } },
          topLevelOnly: { type: 'array', items: { type: 'string' } }
        },
        additionalProperties: false
      }
    ]
  },
  create(context) {
    const allow = new Set<string>(context.options[0]?.allow ?? []);
    const topLevelOnly = new Set<string>(context.options[0]?.topLevelOnly ?? []);
    return {
      Program(node) {
        const globalScope = context.sourceCode.getScope(node);
        // Only the global scope records where a name came from, so collect the
        // configured names once and match nested declarations against them.
        const configured = new Set<string>();
        for (const variable of globalScope.variables) {
          const setting = (variable as ConfiguredGlobal)
            .eslintImplicitGlobalSetting;
          if (setting === 'readonly' || setting === 'writable') {
            configured.add(variable.name);
          }
        }

        const scopes: Scope.Scope[] = [globalScope];
        for (let i = 0; i < scopes.length; i++) {
          scopes.push(...scopes[i].childScopes);
          const nested = i > 0;
          for (const variable of scopes[i].variables) {
            if (!configured.has(variable.name) || allow.has(variable.name)) {
              continue;
            }
            if (nested && topLevelOnly.has(variable.name)) {
              continue;
            }
            // A configured global with no identifiers is only referenced here.
            for (const identifier of variable.identifiers) {
              context.report({
                node: identifier,
                messageId: 'shadowed',
                data: { name: variable.name }
              });
            }
          }
        }
      }
    };
  }
};

/**
 * Load ESLint only when an embedded JavaScript region actually needs linting.
 */
function getLinter(): LinterType {
  if (!linter) {
    // eslint is deliberately required lazily to keep XML-only activation lighter.
    const { Linter } = require('eslint') as typeof import('eslint');
    linter = new Linter();
    linter.defineRules({
      ...Object.fromEntries(
        Object.entries(SERVICENOW_RULES).map(([name, rule]) => [
          `servicenow/${name}`,
          rule
        ])
      ),
      [SHADOWED_PLATFORM_GLOBAL_RULE]: noShadowedPlatformGlobal
    });
  }
  return linter;
}

const configCache = new Map<string, LinterType.Config>();

/**
 * Build (and cache) the ESLint config for a script profile.
 *
 * Cached because Script Include maps are large and `lintScriptRegions` asks
 * for a config per region; the key includes caller scope and extra declarations.
 */
function configFor(
  profile: 'server' | 'client',
  javascriptSupport: JavaScriptSupport,
  callerScope: string | undefined,
  ownDeclarationName: string | undefined,
  extraDeclarations: ScriptDeclaration[]
): LinterType.Config {
  const cacheKey = `${profile}:${javascriptSupport}:${callerScope ?? ''}:${ownDeclarationName ?? ''}:${scriptDeclarationsKey(extraDeclarations)}`;
  const cached = configCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Indexed / bundled Script Include names come first so the hand-maintained
  // platform lists win if an instance ever ships a Script Include that shadows
  // a Glide API.
  const declarationGlobals = globalsForDeclarations({
    profile,
    callerScope,
    bundledScriptIncludes: SCRIPT_INCLUDES,
    bundledScopes: SCOPES,
    extra: extraDeclarations
  });
  const globals =
    profile === 'client'
      ? { ...PLATFORM_FEATURE_GLOBALS, ...declarationGlobals, ...CLIENT_GLOBALS }
      : {
          ...PLATFORM_FEATURE_GLOBALS,
          ...declarationGlobals,
          ...SERVER_GLOBALS,
          ...CLIENT_GLOBALS
        };
  const platformRules =
    javascriptSupport === 'ES5'
      ? { ...PLATFORM_RULES_ALL_MODES, ...PLATFORM_RULES_ES5_ONLY }
      : PLATFORM_RULES_ALL_MODES;

  // Names that are globals for a reason other than the platform binding them,
  // so declaring them shadows nothing. Bundled Script Includes (JSUtil,
  // ArrayUtil) are absent: an instance supplies those, so declaring one does
  // shadow it. Indexed and same-document records are source in the workspace
  // rather than platform API, and the record's own name stays exempt even when
  // it is inactive, has no resolvable scope, or overrides a bundled name.
  const shadowAllow = Object.keys(
    globalsForDeclarations({ profile, callerScope, extra: extraDeclarations })
  );
  if (ownDeclarationName) {
    shadowAllow.push(ownDeclarationName);
  }
  if (javascriptSupport === 'ES5') {
    // ES5 instances do not supply these, so a hand-written polyfill is the
    // declaration rather than a shadow.
    shadowAllow.push(...Object.keys(PLATFORM_FEATURE_GLOBALS));
  }
  if (profile === 'server') {
    // Client names are merged into the server profile only to tolerate mixed
    // legacy code; the ones a server script never receives are fair game.
    for (const name of Object.keys(CLIENT_GLOBALS)) {
      if (!(name in SERVER_GLOBALS)) {
        shadowAllow.push(name);
      }
    }
  }

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
      // Script Include / UI Script names are supplied as `globals` so `no-undef`
      // resolves cross-record references. `no-redeclare` defaults to
      // builtinGlobals: true, which then treats the record's own
      // `var Name = Class.create()` as redeclaring a built-in. Duplicate
      // declarations inside one script body are still reported.
      'no-redeclare': ['error', { builtinGlobals: false }],
      [SHADOWED_PLATFORM_GLOBAL_RULE]: [
        'warn',
        { allow: shadowAllow, topLevelOnly: SHADOW_TOP_LEVEL_ONLY }
      ],
      // Writing to a readonly global replaces the platform's or another
      // record's value for the transaction. The owning record is exempt so a
      // Script Include that assigns its own name without `var` still works.
      'no-global-assign': [
        'error',
        { exceptions: ownDeclarationName ? [ownDeclarationName] : [] }
      ],
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
export function lintScriptRegions(
  regions: ScriptRegion[],
  extraDeclarations: ScriptDeclaration[] = []
): SnDiagnostic[] {
  const out: SnDiagnostic[] = [];
  const engine = getLinter();

  for (const region of regions) {
    out.push(...encodingDiagnostics(region));

    const javascriptSupport = region.javascriptSupport ?? 'ES5';
    const config = configFor(
      region.profile,
      javascriptSupport,
      region.callerScope,
      region.ownDeclarationName,
      extraDeclarations
    );
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

      // A parse error is fatal for the region: ESLint returns it alone, so
      // every other check on this field is missing rather than passing.
      const fatal = msg.fatal === true;
      out.push({
        message: `[${region.fieldName}] [${javascriptSupport}] ${msg.message}${
          msg.ruleId ? ` (${msg.ruleId})` : ''
        }${fatal ? ' No other checks ran for this field.' : ''}`,
        severity: msg.severity === 2 ? 'error' : 'warning',
        line: start.line,
        character: start.character,
        endLine,
        endCharacter,
        code: msg.ruleId ?? (fatal ? 'eslint-parse-error' : 'eslint')
      });
    }
  }

  return out;
}
