import { Linter, type Linter as LinterType } from 'eslint';
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

let linter: Linter | undefined;

function getLinter(): Linter {
  if (!linter) {
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
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
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
 * Lint extracted script regions and return diagnostics in host XML coordinates.
 */
export function lintScriptRegions(regions: ScriptRegion[]): SnDiagnostic[] {
  const out: SnDiagnostic[] = [];
  const engine = getLinter();

  for (const region of regions) {
    const config = configFor(region.profile);
    let messages: LinterType.LintMessage[];
    try {
      messages = engine.verify(region.content, config, {
        filename: `${region.tableName}.${region.fieldName}.js`
      });
    } catch (err) {
      const pos = mapScriptOffsetToXml(region, 0, 0);
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
      const start = mapScriptOffsetToXml(region, lineInScript, colInScript);

      let endLine = start.line;
      let endCharacter = start.character + 1;
      if (msg.endLine != null && msg.endColumn != null) {
        const end = mapScriptOffsetToXml(
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
