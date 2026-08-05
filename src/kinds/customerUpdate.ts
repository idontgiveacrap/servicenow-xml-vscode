import { XMLValidator } from 'fast-xml-parser';
import { KindProfile, SnDiagnostic } from './types';
import {
  extractRowElement,
  isPrimaryAction,
  isValidSysId,
  offsetToPosition
} from '../parseSnXml';

/**
 * Customer update / remote update-set XML.
 *
 * Shapes:
 * - Single <sys_update_xml> under <unload> (one customer update)
 * - <sys_remote_update_set> header + many <sys_update_xml> children (retrieved/loaded update set)
 */
export const customerUpdate: KindProfile = {
  id: 'customer_update',
  label: 'Customer / update-set',
  lintScripts: false,
  lintJson: false,

  matches(doc) {
    return doc.rows.some(
      (r) =>
        r.tableName === 'sys_update_xml' ||
        r.tableName === 'sys_remote_update_set' ||
        r.tableName === 'sys_update_set'
    );
  },

  validate(doc) {
    const diagnostics: SnDiagnostic[] = [];
    const remoteSets = doc.rows.filter((r) => r.tableName === 'sys_remote_update_set');
    const localSets = doc.rows.filter((r) => r.tableName === 'sys_update_set');
    const updates = doc.rows.filter((r) => r.tableName === 'sys_update_xml');

    if (remoteSets.length === 0 && localSets.length === 0 && updates.length === 0) {
      diagnostics.push({
        message:
          'Customer / update-set: expected <sys_remote_update_set>, <sys_update_set>, and/or <sys_update_xml> rows.',
        severity: 'warning',
        line: 0,
        character: 0,
        code: 'cu-no-rows'
      });
      return diagnostics;
    }

    if (doc.rootName !== 'unload' && doc.rootName !== 'record_update') {
      diagnostics.push({
        message:
          'Update-set / customer-update exports are usually wrapped in <unload>.',
        severity: 'information',
        line: 0,
        character: 0,
        code: 'cu-root-info'
      });
    }

    const remoteSetIds = new Set<string>();

    for (const row of remoteSets) {
      validateRemoteUpdateSet(doc, row, diagnostics);
      if (row.sysId && isValidSysId(row.sysId)) {
        remoteSetIds.add(row.sysId.toLowerCase());
      }
    }

    for (const row of localSets) {
      validateLocalUpdateSet(doc, row, diagnostics);
    }

    if (remoteSets.length > 0 && updates.length === 0) {
      diagnostics.push({
        message:
          '<sys_remote_update_set> has no sibling <sys_update_xml> rows (header-only export).',
        severity: 'information',
        line: remoteSets[0].line,
        character: remoteSets[0].character,
        code: 'cu-remote-header-only'
      });
    }

    for (const row of updates) {
      validateUpdateXml(doc, row, diagnostics, remoteSetIds);
    }

    return diagnostics;
  }
};

function validateRemoteUpdateSet(
  doc: { text: string },
  row: {
    action: string;
    sysId?: string;
    sysIdLine?: number;
    sysIdCharacter?: number;
    line: number;
    character: number;
    startOffset: number;
    endOffset: number;
  },
  diagnostics: SnDiagnostic[]
): void {
  if (!isPrimaryAction(row.action) && row.action !== 'DELETE') {
    diagnostics.push({
      message: `Unexpected action "${row.action}" on <sys_remote_update_set>.`,
      severity: 'warning',
      line: row.line,
      character: row.character,
      code: 'cu-remote-bad-action'
    });
  }

  if (!row.sysId) {
    diagnostics.push({
      message: '<sys_remote_update_set> is missing <sys_id>.',
      severity: 'error',
      line: row.line,
      character: row.character,
      code: 'cu-remote-missing-sys-id'
    });
  } else if (!isValidSysId(row.sysId)) {
    diagnostics.push({
      message: `sys_id "${row.sysId}" is not a 32-character hex id.`,
      severity: 'error',
      line: row.sysIdLine ?? row.line,
      character: row.sysIdCharacter ?? row.character,
      code: 'cu-remote-bad-sys-id'
    });
  }

  const rowXml = doc.text.slice(row.startOffset, row.endOffset);

  const nameEl = extractRowElement(rowXml, 'name');
  if (!nameEl || !nameEl.content.trim()) {
    diagnostics.push({
      message: '<sys_remote_update_set> is missing <name>.',
      severity: 'error',
      line: row.line,
      character: row.character,
      code: 'cu-remote-missing-name'
    });
  }

  const stateEl = extractRowElement(rowXml, 'state');
  if (!stateEl || !stateEl.content.trim()) {
    diagnostics.push({
      message: '<sys_remote_update_set> is missing <state> (e.g. loaded, committed).',
      severity: 'warning',
      line: row.line,
      character: row.character,
      code: 'cu-remote-missing-state'
    });
  }

  const remoteSysIdEl = extractRowElement(rowXml, 'remote_sys_id');
  if (remoteSysIdEl && remoteSysIdEl.content.trim() && !isValidSysId(remoteSysIdEl.content.trim())) {
    diagnostics.push({
      message: `<remote_sys_id> "${remoteSysIdEl.content.trim()}" is not a 32-character hex id.`,
      severity: 'error',
      line: row.line,
      character: row.character,
      code: 'cu-remote-bad-remote-sys-id'
    });
  }
}

function validateLocalUpdateSet(
  doc: { text: string },
  row: {
    action: string;
    sysId?: string;
    sysIdLine?: number;
    sysIdCharacter?: number;
    line: number;
    character: number;
    startOffset: number;
    endOffset: number;
  },
  diagnostics: SnDiagnostic[]
): void {
  if (!row.sysId) {
    diagnostics.push({
      message: '<sys_update_set> is missing <sys_id>.',
      severity: 'error',
      line: row.line,
      character: row.character,
      code: 'cu-set-missing-sys-id'
    });
  } else if (!isValidSysId(row.sysId)) {
    diagnostics.push({
      message: `sys_id "${row.sysId}" is not a 32-character hex id.`,
      severity: 'error',
      line: row.sysIdLine ?? row.line,
      character: row.sysIdCharacter ?? row.character,
      code: 'cu-set-bad-sys-id'
    });
  }

  const rowXml = doc.text.slice(row.startOffset, row.endOffset);
  const nameEl = extractRowElement(rowXml, 'name');
  if (!nameEl || !nameEl.content.trim()) {
    diagnostics.push({
      message: '<sys_update_set> is missing <name>.',
      severity: 'warning',
      line: row.line,
      character: row.character,
      code: 'cu-set-missing-name'
    });
  }
}

function validateUpdateXml(
  doc: { text: string },
  row: {
    action: string;
    sysId?: string;
    sysIdLine?: number;
    sysIdCharacter?: number;
    line: number;
    character: number;
    startOffset: number;
    endOffset: number;
  },
  diagnostics: SnDiagnostic[],
  remoteSetIds: Set<string>
): void {
  if (!isPrimaryAction(row.action) && row.action !== 'DELETE') {
    diagnostics.push({
      message: `Unexpected action "${row.action}" on <sys_update_xml>.`,
      severity: 'warning',
      line: row.line,
      character: row.character,
      code: 'cu-bad-action'
    });
  }

  if (!row.sysId) {
    diagnostics.push({
      message: '<sys_update_xml> is missing <sys_id>.',
      severity: 'error',
      line: row.line,
      character: row.character,
      code: 'cu-missing-sys-id'
    });
  } else if (!isValidSysId(row.sysId)) {
    diagnostics.push({
      message: `sys_id "${row.sysId}" is not a 32-character hex id.`,
      severity: 'error',
      line: row.sysIdLine ?? row.line,
      character: row.sysIdCharacter ?? row.character,
      code: 'cu-bad-sys-id'
    });
  }

  const rowXml = doc.text.slice(row.startOffset, row.endOffset);

  const nameEl = extractRowElement(rowXml, 'name');
  if (!nameEl || !nameEl.content.trim()) {
    diagnostics.push({
      message: '<sys_update_xml> is missing <name> (update name / target key).',
      severity: 'error',
      line: row.line,
      character: row.character,
      code: 'cu-missing-name'
    });
  }

  const typeEl = extractRowElement(rowXml, 'type');
  if (!typeEl || !typeEl.content.trim()) {
    diagnostics.push({
      message: '<sys_update_xml> is missing <type>.',
      severity: 'warning',
      line: row.line,
      character: row.character,
      code: 'cu-missing-type'
    });
  }

  // <table> is often empty on remote update-set members; require table or target_name
  const tableEl = extractRowElement(rowXml, 'table');
  const targetNameEl = extractRowElement(rowXml, 'target_name');
  const tableVal = tableEl?.content.trim() ?? '';
  const targetVal = targetNameEl?.content.trim() ?? '';
  if (!tableVal && !targetVal) {
    diagnostics.push({
      message:
        '<sys_update_xml> has empty <table> and <target_name> (expected at least one).',
      severity: 'warning',
      line: row.line,
      character: row.character,
      code: 'cu-missing-table-or-target'
    });
  }

  const remoteRef = extractRowElement(rowXml, 'remote_update_set');
  if (remoteRef && remoteRef.content.trim()) {
    const refId = remoteRef.content.trim().toLowerCase();
    if (!isValidSysId(refId)) {
      diagnostics.push({
        message: `<remote_update_set> "${remoteRef.content.trim()}" is not a 32-character hex id.`,
        severity: 'error',
        line: row.line,
        character: row.character,
        code: 'cu-bad-remote-ref'
      });
    } else if (remoteSetIds.size > 0 && !remoteSetIds.has(refId)) {
      diagnostics.push({
        message: `<remote_update_set> ${refId} does not match a <sys_remote_update_set> sys_id in this file.`,
        severity: 'warning',
        line: row.line,
        character: row.character,
        code: 'cu-remote-ref-mismatch'
      });
    }
  } else if (remoteSetIds.size > 0) {
    diagnostics.push({
      message:
        '<sys_update_xml> is missing <remote_update_set> while this file includes a <sys_remote_update_set>.',
      severity: 'warning',
      line: row.line,
      character: row.character,
      code: 'cu-missing-remote-ref'
    });
  }

  const payloadEl = extractRowElement(rowXml, 'payload');
  if (!payloadEl) {
    if (row.action !== 'DELETE') {
      diagnostics.push({
        message: '<sys_update_xml> is missing <payload> CDATA.',
        severity: 'error',
        line: row.line,
        character: row.character,
        code: 'cu-missing-payload'
      });
    }
  } else {
    if (!payloadEl.isCdata) {
      diagnostics.push({
        message: '<payload> should use CDATA for nested update XML.',
        severity: 'warning',
        line: row.line,
        character: row.character,
        code: 'cu-payload-not-cdata'
      });
    }
    const payload = payloadEl.content.trim();
    if (payload.length > 0) {
      const validation = XMLValidator.validate(payload, {
        allowBooleanAttributes: true
      });
      if (validation !== true) {
        const err = validation as {
          err: { msg: string; line: number; col: number };
        };
        const cdataToken = '<![CDATA[';
        const payloadTag = rowXml.indexOf('<payload');
        const cdataAt = rowXml.indexOf(cdataToken, payloadTag >= 0 ? payloadTag : 0);
        const bodyAbs =
          cdataAt >= 0
            ? row.startOffset + cdataAt + cdataToken.length
            : row.startOffset;
        const pos = offsetToPosition(doc.text, bodyAbs);
        diagnostics.push({
          message: `Invalid XML inside <payload>: ${err.err?.msg ?? 'parse error'}`,
          severity: 'error',
          line: pos.line + Math.max(0, (err.err?.line ?? 1) - 1),
          character:
            (err.err?.line ?? 1) <= 1
              ? pos.character + Math.max(0, (err.err?.col ?? 1) - 1)
              : Math.max(0, (err.err?.col ?? 1) - 1),
          code: 'cu-payload-invalid-xml'
        });
      } else if (!/<\s*record_update\b/i.test(payload)) {
        diagnostics.push({
          message:
            '<payload> is well-formed XML but does not contain a <record_update> root (unusual for customer updates).',
          severity: 'information',
          line: row.line,
          character: row.character,
          code: 'cu-payload-no-record-update'
        });
      }
    }
  }

  const categoryEl = extractRowElement(rowXml, 'category');
  if (categoryEl && categoryEl.content.trim() && categoryEl.content.trim() !== 'customer') {
    diagnostics.push({
      message: `<category> is "${categoryEl.content.trim()}" (often "customer" for customer updates).`,
      severity: 'information',
      line: row.line,
      character: row.character,
      code: 'cu-category'
    });
  }
}
