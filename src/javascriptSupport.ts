/**
 * JavaScript modes exposed by ServiceNow application records.
 *
 * Compatibility mode is treated as ES5 for linting. It supports no more modern
 * syntax than ES5, and ES5 is the required fallback when metadata is absent.
 */
export type JavaScriptSupport = 'ES5' | 'ES12';

const ES12_VALUES = new Set([
  'es12',
  'es_12',
  'es_latest',
  'ecmascript 2021',
  'ecmascript2021'
]);

const ES5_VALUES = new Set([
  'es5',
  'es_5',
  'helsinki_es5',
  'traditional',
  'compatibility'
]);

/**
 * Normalize a ServiceNow `sys_app.js_level` value to a lint target.
 */
export function normalizeJavaScriptSupport(
  value: string | undefined
): JavaScriptSupport | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (ES12_VALUES.has(normalized)) {
    return 'ES12';
  }
  if (ES5_VALUES.has(normalized)) {
    return 'ES5';
  }
  return undefined;
}

/**
 * Read the application JavaScript mode from exported XML.
 *
 * Individual-script ES12 overrides live in separate `sys_es_latest_script`
 * records and are not present in normal record XML exports, so an absent or
 * unrecognized application mode intentionally resolves to ES5.
 */
export function detectJavaScriptSupport(
  xml: string,
  fallback: JavaScriptSupport = 'ES5'
): JavaScriptSupport {
  const appRow = xml.match(/<\s*sys_app\b[^>]*>[\s\S]*?<\/\s*sys_app\s*>/i)?.[0];
  if (!appRow) {
    return fallback;
  }
  const levelMatch = appRow.match(
    /<\s*js_level\b[^>]*>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/\s*js_level\s*>/i
  );
  const support = normalizeJavaScriptSupport(
    levelMatch?.[1] ?? levelMatch?.[2]
  );
  if (support !== 'ES12') {
    return support ?? fallback;
  }

  const scopeMatch = appRow.match(
    /<\s*scope\b[^>]*>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/\s*scope\s*>/i
  );
  const scope = (scopeMatch?.[1] ?? scopeMatch?.[2])?.trim().toLowerCase();
  return scope && scope !== 'global' ? 'ES12' : fallback;
}
