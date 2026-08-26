import { CLIENT_SCRIPT_FIELD_PAIRS } from './kinds/scriptFields.generated';

const CLIENT_TABLES = new Set([
  'sys_ux_client_script',
  'sys_ux_client_script_include',
  'sys_ui_script',
  'sys_client_script',
  'sys_ui_policy'
]);

const CLIENT_FIELDS = new Set([
  'client_script',
  'client_script_v2',
  'script_true',
  'script_false'
]);

/**
 * Pick the ESLint global set for a script body. Field name wins over table
 * because a single table can hold both sides: sys_ui_page carries browser code
 * in client_script and server code in processing_script.
 */
export function resolveScriptProfile(
  tableName: string,
  fieldName: string
): 'server' | 'client' {
  if (CLIENT_SCRIPT_FIELD_PAIRS.has(`${tableName}.${fieldName}`)) {
    return 'client';
  }
  if (CLIENT_FIELDS.has(fieldName)) {
    return 'client';
  }
  if (CLIENT_TABLES.has(tableName)) {
    return 'client';
  }
  return 'server';
}
