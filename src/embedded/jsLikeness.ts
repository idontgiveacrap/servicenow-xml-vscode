/**
 * Content-based test for "is this text a script?", used by the embedded-script
 * editor instead of matching ServiceNow field names.
 *
 * A bare parse check is far too permissive: `general`, `true`, `300000`, and any
 * sys_id starting with a letter are all valid JavaScript programs, and those are
 * ordinary values of non-script ServiceNow fields. So a candidate must parse AND
 * contain a construct that only appears in code, never in a scalar field value.
 */

/** Statement types that only appear in real script bodies. */
const SCRIPT_STATEMENTS = new Set([
  'FunctionDeclaration',
  'ClassDeclaration',
  'VariableDeclaration',
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'SwitchStatement',
  'TryStatement',
  'ThrowStatement',
  'ReturnStatement',
  'WithStatement',
  'LabeledStatement'
]);

/** Expressions that imply behavior rather than a scalar value. */
const SCRIPT_EXPRESSIONS = new Set([
  'CallExpression',
  'NewExpression',
  'AssignmentExpression',
  'UpdateExpression',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassExpression',
  'TaggedTemplateExpression',
  'AwaitExpression',
  'YieldExpression'
]);

export interface JsLikenessResult {
  ok: boolean;
  /** Why the candidate was rejected, for the "no script here" message. */
  reason?: string;
}

interface EspreeNode {
  type: string;
  expression?: EspreeNode;
  body?: EspreeNode[];
}

let parse: ((code: string, options: object) => { body: EspreeNode[] }) | undefined;

/**
 * espree ships with ESLint, which is already a runtime dependency; load it lazily
 * so XML-only activation does not pull in the parser.
 */
function getParser(): (code: string, options: object) => { body: EspreeNode[] } {
  if (!parse) {
    const espree = require('espree') as {
      parse: (code: string, options: object) => { body: EspreeNode[] };
    };
    parse = espree.parse;
  }
  return parse;
}

/**
 * True when `code` parses as JavaScript and does something, rather than merely
 * being a value that happens to be syntactically valid.
 *
 * Deliberately accepts a lone call expression: `response.sendRedirect(…)` is the
 * entire body of a real sys_ui_page processing_script.
 */
export function looksLikeJavaScript(code: string): JsLikenessResult {
  const trimmed = code.trim();
  if (trimmed.length < 3) {
    return { ok: false, reason: 'value is too short to be a script' };
  }

  let program: { body: EspreeNode[] };
  try {
    program = getParser()(trimmed, {
      ecmaVersion: 2022,
      sourceType: 'script'
    });
  } catch {
    return { ok: false, reason: 'does not parse as JavaScript' };
  }

  const body = program.body ?? [];
  if (body.length === 0) {
    return { ok: false, reason: 'parses to an empty program' };
  }

  for (const node of body) {
    if (SCRIPT_STATEMENTS.has(node.type)) {
      return { ok: true };
    }
    if (node.type === 'ExpressionStatement' && node.expression) {
      if (SCRIPT_EXPRESSIONS.has(node.expression.type)) {
        return { ok: true };
      }
      // An object or array literal on its own is JSON data that happens to be a
      // valid expression; treat it as data so JSON fields do not open as scripts.
      continue;
    }
    if (node.type === 'BlockStatement' || node.type === 'EmptyStatement') {
      continue;
    }
  }

  // Several statements in sequence is itself evidence of code, even when each
  // one is individually inert (e.g. a list of bare identifiers is not, but
  // `a.b; c.d;` reaching here would already have matched a call above).
  if (body.length > 1) {
    return { ok: true };
  }

  return { ok: false, reason: 'parses as a plain value, not code' };
}
