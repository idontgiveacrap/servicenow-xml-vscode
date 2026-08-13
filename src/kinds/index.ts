import {
  ClassificationResult,
  DocumentKindId,
  KindProfile,
  ParsedDocument,
  ValidationContext
} from './types';
import { scopedAppRecordUpdate } from './scopedAppRecordUpdate';
import { dataRecordExport } from './dataRecordExport';
import { customerUpdate } from './customerUpdate';
import { unknownSnXml } from './unknown';

/**
 * Ordered kind profiles — first match wins. `unknownSnXml` is deliberately
 * excluded: it matches everything, so it is applied as the explicit fallback
 * after this list rather than as a list entry that would shadow nothing.
 */
export const KIND_PROFILES: KindProfile[] = [
  customerUpdate,
  scopedAppRecordUpdate,
  dataRecordExport
];

/**
 * Classify a parsed document and run the matching kind's structural rules.
 */
export function classifyAndValidate(
  doc: ParsedDocument,
  ctx?: ValidationContext
): ClassificationResult {
  if (!doc.wellFormed) {
    return {
      kind: 'not_xml',
      label: 'Not well-formed XML',
      diagnostics: doc.parseError ? [doc.parseError] : [],
      lintScripts: false,
      lintJson: false
    };
  }

  const profile =
    KIND_PROFILES.find((candidate) => candidate.matches(doc)) ?? unknownSnXml;

  const diagnostics = profile.validate(doc, ctx);
  if (profile.pendingRulesNote) {
    diagnostics.push({
      message: profile.pendingRulesNote,
      severity: 'information',
      line: 0,
      character: 0,
      code: `${profile.id}-pending-rules`
    });
  }
  return {
    kind: profile.id,
    label: profile.label,
    diagnostics,
    lintScripts: profile.lintScripts,
    lintJson: profile.lintJson === true,
    pendingRulesNote: profile.pendingRulesNote
  };
}

export function kindDisplayLabel(kind: DocumentKindId): string {
  switch (kind) {
    case 'scoped_app_record_update':
      return 'Scoped app record update';
    case 'data_record_export':
      return 'Data record export';
    case 'customer_update':
      return 'Customer / update-set';
    case 'unknown_sn_xml':
      return 'Unknown SN XML';
    case 'not_xml':
      return 'Invalid XML';
    default:
      return kind;
  }
}

export type { SnDiagnostic, ParsedDocument, ClassificationResult } from './types';
