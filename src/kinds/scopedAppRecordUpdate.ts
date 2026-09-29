import { KindProfile, SnDiagnostic, STRICT_RECORD_ACTIONS } from './types';
import {
  extractRowFieldText,
  isCleanupAction,
  isPrimaryAction,
  isValidSysId,
  scanDirectChildElements
} from '../parseSnXml';
import { parseExportFileName } from '../fileName';

/**
 * Scoped application / Studio git-export record_update payloads, and
 * platform list/form Unload XML of the same metadata records (sys_scope / sys_update_name).
 */
export const scopedAppRecordUpdate: KindProfile = {
  id: 'scoped_app_record_update',
  label: 'Scoped app record update',
  lintScripts: true,
  lintJson: true,

  matches(doc) {
    const rootOk = doc.rootName === 'record_update' || doc.rootName === 'unload';
    if (!rootOk || doc.rows.length === 0) {
      return false;
    }
    // App-export / metadata markers on at least one primary row
    return doc.rows.some(
      (r) =>
        isPrimaryAction(r.action) &&
        (r.hasSysScope || r.hasSysUpdateName || r.hasSysPackage)
    );
  },

  validate(doc, ctx) {
    const diagnostics: SnDiagnostic[] = [];

    if (doc.rootName !== 'record_update' && doc.rootName !== 'unload') {
      diagnostics.push({
        message:
          'Scoped app / metadata exports should use a <record_update> or <unload> root element.',
        severity: 'error',
        line: 0,
        character: 0,
        code: 'scoped-root'
      });
    }

    const primaryRows = doc.rows.filter((r) => isPrimaryAction(r.action));
    const cleanupRows = doc.rows.filter((r) => isCleanupAction(r.action));
    const otherRows = doc.rows.filter(
      (r) => !isPrimaryAction(r.action) && !isCleanupAction(r.action)
    );

    if (primaryRows.length === 0 && cleanupRows.length === 0) {
      diagnostics.push({
        message:
          'Expected at least one child element with action INSERT_OR_UPDATE, DELETE, or a known cleanup action.',
        severity: 'error',
        line: 0,
        character: 0,
        code: 'scoped-no-action-row'
      });
    }

    for (const row of otherRows) {
      diagnostics.push({
        message: `Unrecognized action "${row.action}" on <${row.tableName}>.`,
        severity: 'warning',
        line: row.line,
        character: row.character,
        code: 'scoped-unknown-action'
      });
    }

    const fileMeta = parseExportFileName(doc.filePath);
    const appId = normalizeAppId(ctx?.workspaceAppSysId);

    for (const row of primaryRows) {
      if (!STRICT_RECORD_ACTIONS.has(row.action)) {
        diagnostics.push({
          message: `<${row.tableName}> action must be INSERT_OR_UPDATE or DELETE (found "${row.action}").`,
          severity: 'error',
          line: row.line,
          character: row.character,
          code: 'scoped-bad-action'
        });
      }

      if (!row.sysId) {
        if (ctx?.requireRecordSysIds) {
          diagnostics.push({
            message: `<${row.tableName}> is missing <sys_id>.`,
            severity: 'error',
            line: row.line,
            character: row.character,
            code: 'scoped-missing-sys-id'
          });
        }
      } else if (!isValidSysId(row.sysId)) {
        diagnostics.push({
          message: `sys_id "${row.sysId}" is not a 32-character hex id.`,
          severity: 'error',
          line: row.sysIdLine ?? row.line,
          character: row.sysIdCharacter ?? row.character,
          code: 'scoped-bad-sys-id'
        });
      }

      if (row.hasSysUpdateName) {
        const rowXml = doc.text.slice(row.startOffset, row.endOffset);
        const sysUpdateName = extractRowFieldText(rowXml, 'sys_update_name');
        const expected = expectedSysUpdateName(row.tableName, row.sysId, rowXml);
        if (
          sysUpdateName &&
          expected &&
          sysUpdateName.toLowerCase() !== expected.toLowerCase()
        ) {
          diagnostics.push({
            message: `sys_update_name "${sysUpdateName}" does not match ${expected}.`,
            severity: 'warning',
            line: row.line,
            character: row.character,
            code: 'scoped-sys-update-name-mismatch'
          });
        }
      }

      if (row.action !== 'DELETE') {
        if (!row.hasSysScope) {
          diagnostics.push({
            message: `<${row.tableName}> is missing <sys_scope> (expected on scoped app / metadata exports).`,
            severity: 'warning',
            line: row.line,
            character: row.character,
            code: 'scoped-missing-sys-scope'
          });
        }
      }

      if (appId) {
        pushAppIdMismatch(
          diagnostics,
          row.sysScopeValue,
          'sys_scope',
          appId,
          row.line,
          row.character,
          'scoped-sys-scope-mismatch'
        );
        pushAppIdMismatch(
          diagnostics,
          row.sysPackageValue,
          'sys_package',
          appId,
          row.line,
          row.character,
          'scoped-sys-package-mismatch'
        );
      }

      if (fileMeta && primaryRows[0] === row) {
        if (fileMeta.table !== row.tableName) {
          diagnostics.push({
            message: `Filename table "${fileMeta.table}" does not match element <${row.tableName}>.`,
            severity: 'warning',
            line: row.line,
            character: row.character,
            code: 'scoped-filename-table-mismatch'
          });
        }
        if (row.sysId && fileMeta.sysId !== row.sysId.toLowerCase()) {
          diagnostics.push({
            message: `Filename sys_id does not match <sys_id> ${row.sysId}.`,
            severity: 'warning',
            line: row.sysIdLine ?? row.line,
            character: row.sysIdCharacter ?? row.character,
            code: 'scoped-filename-sys-id-mismatch'
          });
        }
      }

      for (const field of row.scriptFields) {
        if (!field.isCdata && field.content.trim().length > 0) {
          diagnostics.push({
            message: `<${field.fieldName}> should wrap script content in CDATA.`,
            severity: 'warning',
            line: field.bodyStartLine,
            character: field.bodyStartCharacter,
            code: 'scoped-script-not-cdata'
          });
        }
      }
    }

    return diagnostics;
  }
};

/**
 * Expected `<sys_update_name>` for a primary row.
 *
 * Ordinary application files use `{table}_{sys_id}`. `sys_metadata_delete`
 * reuses the deleted file's update name (`{source_table}_{sys_metadata}`).
 * `sys_update_version` has no `sys_update_name` of its own (its `<name>` holds
 * the source update name); callers skip when this returns undefined.
 */
function expectedSysUpdateName(
  tableName: string,
  sysId: string | undefined,
  rowXml: string
): string | undefined {
  if (tableName === 'sys_update_version') {
    return undefined;
  }
  if (tableName === 'sys_metadata_delete') {
    const metadataId = extractRowFieldText(rowXml, 'sys_metadata');
    if (!metadataId || !isValidSysId(metadataId)) {
      return undefined;
    }
    const sourceTable =
      extractRowFieldAttribute(rowXml, 'sys_db_object', 'name') ||
      extractRowFieldText(rowXml, 'sys_db_object');
    if (!sourceTable) {
      return undefined;
    }
    return `${sourceTable}_${metadataId}`;
  }
  if (sysId && isValidSysId(sysId)) {
    return `${tableName}_${sysId}`;
  }
  return undefined;
}

/** Attribute on a named direct child, e.g. `<sys_db_object name="…">`. */
function extractRowFieldAttribute(
  rowXml: string,
  fieldName: string,
  attrName: string
): string | undefined {
  const want = fieldName.toLowerCase();
  const child = scanDirectChildElements(rowXml).find(
    (c) => c.name.toLowerCase() === want
  );
  if (!child) {
    return undefined;
  }
  const openTag = rowXml.slice(child.start, child.bodyStart);
  const attr = openTag.match(
    new RegExp(
      `\\b${attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
      'i'
    )
  );
  const value = (attr?.[1] ?? attr?.[2] ?? '').trim();
  return value || undefined;
}

function normalizeAppId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
}

function pushAppIdMismatch(
  diagnostics: SnDiagnostic[],
  value: string | undefined,
  fieldLabel: string,
  appId: string,
  line: number,
  character: number,
  code: string
): void {
  if (!value) {
    return;
  }
  if (value.toLowerCase() === appId) {
    return;
  }
  diagnostics.push({
    message: `<${fieldLabel}> "${value}" does not match workspace application id ${appId}.`,
    severity: 'warning',
    line,
    character,
    code
  });
}
