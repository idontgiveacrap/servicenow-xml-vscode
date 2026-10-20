/**
 * Per-table expectations for source-control exports.
 *
 * The default record key is `sys_id`. Some tables still carry a sys_id, but
 * source control does not use it as the primary key. Later composite keys
 * (table + element, language, and so on) belong on `RecordKey`, not as
 * one-off checks at each call site.
 */

export type RecordKey = { kind: 'sys_id' } | { kind: 'not_sys_id' };

const NOT_SYS_ID_TABLES = new Set([
  'sys_dictionary',
  'sys_documentation',
  'sys_choice_set'
]);

const SYS_ID_KEY: RecordKey = { kind: 'sys_id' };
const NOT_SYS_ID_KEY: RecordKey = { kind: 'not_sys_id' };

/**
 * How rows of `table` are identified in an export.
 * Unknown and empty names use `sys_id`.
 */
export function recordKey(table: string | undefined): RecordKey {
  if (table && NOT_SYS_ID_TABLES.has(table.toLowerCase())) {
    return NOT_SYS_ID_KEY;
  }
  return SYS_ID_KEY;
}
