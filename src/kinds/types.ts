/**
 * Shared types for ServiceNow XML document kinds and diagnostics.
 */

export type DocumentKindId =
  | 'scoped_app_record_update'
  | 'data_record_export'
  | 'customer_update'
  | 'unknown_sn_xml'
  | 'not_xml';

export type DiagnosticSeverityLevel = 'error' | 'warning' | 'information' | 'hint';

/** A diagnostic produced by kind rules or the XML parser. */
export interface SnDiagnostic {
  message: string;
  severity: DiagnosticSeverityLevel;
  /** 0-based line */
  line: number;
  /** 0-based character */
  character: number;
  /** Optional end line (0-based); defaults to line */
  endLine?: number;
  /** Optional end character; defaults to character + 1 */
  endCharacter?: number;
  code?: string;
}

export type EmbeddedLanguage = 'javascript' | 'json' | 'css';

/** One table-named child under record_update / unload (or equivalent root). */
export interface RecordRow {
  tableName: string;
  action: string;
  /** Offset of the opening tag in the source text */
  startOffset: number;
  endOffset: number;
  line: number;
  character: number;
  sysId?: string;
  sysIdLine?: number;
  sysIdCharacter?: number;
  hasSysScope: boolean;
  hasSysUpdateName: boolean;
  hasSysPackage: boolean;
  /** Script / JSON / CSS field hits on this row */
  embeddedFields: EmbeddedFieldHit[];
  /** Convenience: JS script fields only */
  scriptFields: EmbeddedFieldHit[];
}

export interface EmbeddedFieldHit {
  fieldName: string;
  language: EmbeddedLanguage;
  isCdata: boolean;
  /** Absolute start offset of body in the document */
  bodyStartOffset: number;
  bodyEndOffset: number;
  bodyStartLine: number;
  bodyStartCharacter: number;
  /** Raw body text as in the XML (may include entities) */
  content: string;
  /** Entity-decoded body for parsing/linting */
  decodedContent: string;
}

export interface ParsedDocument {
  text: string;
  filePath?: string;
  wellFormed: boolean;
  parseError?: SnDiagnostic;
  rootName?: string;
  rows: RecordRow[];
  /** True when unload root is present */
  hasUnloadRoot: boolean;
  hasUpdateSetMarkers: boolean;
}

export interface KindProfile {
  id: DocumentKindId;
  label: string;
  /** Return true when this profile claims the document. First match wins. */
  matches: (doc: ParsedDocument) => boolean;
  /** Structure diagnostics for this kind. */
  validate: (doc: ParsedDocument) => SnDiagnostic[];
  /** Whether JS lint should run for INSERT_OR_UPDATE script rows. */
  lintScripts: boolean;
  /** Whether JSON field well-formedness should be checked. */
  lintJson?: boolean;
  /** Optional note shown when rules are incomplete. */
  pendingRulesNote?: string;
}

export interface ClassificationResult {
  kind: DocumentKindId;
  label: string;
  diagnostics: SnDiagnostic[];
  lintScripts: boolean;
  lintJson: boolean;
  pendingRulesNote?: string;
}

/** Known executable script field element names (CDATA expected). */
export const SCRIPT_FIELD_NAMES = [
  'script',
  'client_script_v2',
  'script_true',
  'script_false'
] as const;

/** Known JSON-ish fields in UX / config exports (plain text or entity-escaped). */
export const JSON_FIELD_NAMES = [
  'composition',
  'layout',
  'props',
  'style_config',
  'output_schema',
  'bundles',
  'data',
  'state_properties',
  'required_translations',
  'component_dependencies',
  'associated_types'
] as const;

/** Known CSS fields. */
export const CSS_FIELD_NAMES = ['css', 'style'] as const;

export const PRIMARY_ACTIONS = new Set([
  'INSERT_OR_UPDATE',
  'DELETE',
  'INSERT',
  'UPDATE'
]);

export const CLEANUP_ACTIONS = new Set(['delete_multiple', 'delete_multi']);

export const SYS_ID_RE = /^[0-9a-f]{32}$/i;

/** Tables that identify customer-update / update-set payload records. */
export const CUSTOMER_UPDATE_TABLES = new Set([
  'sys_update_xml',
  'sys_remote_update_set',
  'sys_update_set'
]);
