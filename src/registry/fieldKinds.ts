/**
 * Compact field-kind lookups from packed dictionary (script / CSS / client pairs).
 * Loaded once for parseSnXml and scriptProfile — avoids shipping scriptFields.generated.ts.
 */

import type { FieldKindsPack } from './fieldKindsTypes';

const PACK: FieldKindsPack = require('../data/fieldKinds.json');

const scriptPairs = new Set(PACK.scriptPairs);
const clientScriptPairs = new Set(PACK.clientScriptPairs);
const cssFieldNames = new Set(
  PACK.cssFieldNames.map((name) => name.toLowerCase())
);
const jsonFieldNames = new Set(
  PACK.jsonFieldNames.map((name) => name.toLowerCase())
);

/** Always-on script element names (CDATA expected) before table.field lookup. */
export const BOOTSTRAP_SCRIPT_FIELD_NAMES = [
  'script',
  'client_script_v2',
  'script_true',
  'script_false'
] as const;

/**
 * True when `fieldName` is a script-typed element for `tableName`.
 */
export function isScriptTypedField(
  tableName: string | undefined,
  fieldName: string
): boolean {
  const name = fieldName.toLowerCase();
  if (
    (BOOTSTRAP_SCRIPT_FIELD_NAMES as readonly string[]).some(
      (n) => n.toLowerCase() === name
    )
  ) {
    return true;
  }
  if (tableName && scriptPairs.has(`${tableName}.${fieldName}`)) {
    return true;
  }
  if (tableName && scriptPairs.has(`${tableName.toLowerCase()}.${name}`)) {
    return true;
  }
  return false;
}

/**
 * True when the field name is CSS-typed (element name match).
 */
export function isCssFieldName(fieldName: string): boolean {
  return cssFieldNames.has(fieldName.toLowerCase());
}

/**
 * True when the field name is JSON-typed (element name match from dictionary pack).
 */
export function isJsonFieldName(fieldName: string): boolean {
  return jsonFieldNames.has(fieldName.toLowerCase());
}

/**
 * True when dictionary marks this table.field as an explicit client script type.
 */
export function isClientScriptPair(tableName: string, fieldName: string): boolean {
  return (
    clientScriptPairs.has(`${tableName}.${fieldName}`) ||
    clientScriptPairs.has(`${tableName.toLowerCase()}.${fieldName.toLowerCase()}`)
  );
}
