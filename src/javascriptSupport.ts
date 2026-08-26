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

/** Fields read from a workspace or in-document `sys_app` export. */
export interface SysAppMetadata {
  /** Sys_id from the `sys_app` row, when present. */
  sysId?: string;
  /** Technical scope from `<scope>` (for example `x_example`). */
  scope?: string;
  /**
   * Mode implied by `js_level` before the global-scope ES12 clamp.
   * Absent when the field is missing or unrecognized.
   */
  jsLevel?: JavaScriptSupport;
}

/**
 * Read `sys_id`, technical `<scope>`, and `js_level` from a `sys_app` row.
 */
export function detectSysAppMetadata(xml: string): SysAppMetadata | undefined {
  const appRow = xml.match(/<\s*sys_app\b[^>]*>[\s\S]*?<\/\s*sys_app\s*>/i)?.[0];
  if (!appRow) {
    return undefined;
  }
  const sysId = elementText(appRow, 'sys_id');
  const scope = elementText(appRow, 'scope');
  const jsLevel = normalizeJavaScriptSupport(elementText(appRow, 'js_level'));
  if (!sysId && !scope && !jsLevel) {
    return {};
  }
  return {
    sysId,
    scope,
    jsLevel
  };
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
  const meta = detectSysAppMetadata(xml);
  if (!meta) {
    return fallback;
  }
  if (meta.jsLevel !== 'ES12') {
    return meta.jsLevel ?? fallback;
  }
  const scope = meta.scope?.trim().toLowerCase();
  return scope && scope !== 'global' ? 'ES12' : fallback;
}

/**
 * Return decoded text of the first matching simple element in `xml`.
 */
function elementText(xml: string, fieldName: string): string | undefined {
  const match = xml.match(
    new RegExp(
      `<\\s*${fieldName}\\b[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</\\s*${fieldName}\\s*>`,
      'i'
    )
  );
  const value = (match?.[1] ?? match?.[2])?.trim();
  return value || undefined;
}
