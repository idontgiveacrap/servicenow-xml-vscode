import { KindProfile, SnDiagnostic } from './types';
import { isPrimaryAction, isValidSysId } from '../parseSnXml';

/**
 * List/form data XML exports: <unload> (or record_update) rows without scoped-app metadata.
 * Often includes JSON-looking custom fields (e.g. import-set staging tables).
 */
export const dataRecordExport: KindProfile = {
  id: 'data_record_export',
  label: 'Data record export',
  lintScripts: true,
  lintJson: true,

  matches(doc) {
    if (doc.rootName !== 'record_update' && !doc.hasUnloadRoot && doc.rootName !== 'unload') {
      return false;
    }
    if (doc.rows.length === 0) {
      return false;
    }
    if (doc.rows.some((r) => r.tableName === 'sys_update_xml')) {
      return false;
    }
    const hasAppMarkers = doc.rows.some(
      (r) => r.hasSysScope || r.hasSysUpdateName || r.hasSysPackage
    );
    if (hasAppMarkers) {
      return false;
    }
    return doc.rows.some((r) => isPrimaryAction(r.action) || !!r.sysId);
  },

  validate(doc, ctx) {
    const diagnostics: SnDiagnostic[] = [];

    if (doc.rootName !== 'unload' && doc.rootName !== 'record_update') {
      diagnostics.push({
        message: 'Data exports usually use an <unload> root (list Export XML).',
        severity: 'information',
        line: 0,
        character: 0,
        code: 'data-root-info'
      });
    }

    const primary = doc.rows.filter((r) => isPrimaryAction(r.action) || !!r.sysId);

    if (primary.length === 0) {
      diagnostics.push({
        message: 'Data export: expected at least one record row with an action or sys_id.',
        severity: 'warning',
        line: 0,
        character: 0,
        code: 'data-no-rows'
      });
      return diagnostics;
    }

    for (const row of primary) {
      if (!row.sysId) {
        if (ctx?.requireRecordSysIds) {
          diagnostics.push({
            message: `<${row.tableName}> is missing <sys_id>.`,
            severity: 'error',
            line: row.line,
            character: row.character,
            code: 'data-missing-sys-id'
          });
        }
      } else if (!isValidSysId(row.sysId)) {
        diagnostics.push({
          message: `sys_id "${row.sysId}" is not a 32-character hex id.`,
          severity: 'error',
          line: row.sysIdLine ?? row.line,
          character: row.sysIdCharacter ?? row.character,
          code: 'data-bad-sys-id'
        });
      }
    }

    return diagnostics;
  }
};
