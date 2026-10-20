/**
 * Pure URL builders for ServiceNow record links from a table/sys_id pair.
 *
 * All paths are instance-relative (no host). A configured base URL is joined
 * elsewhere so these functions stay free of VS Code and host concerns.
 */

/** The four ServiceNow URL variants for one record row. */
export interface RecordUrls {
  /** Studio: `/servicenow_studio.do?table={table}&sysId={sysId}` */
  studio: string;
  /** Standard form via nav_to: `/nav_to.do?uri={table}.do?sys_id={sysId}` */
  navForm: string;
  /** JSON API: `/{table}.do?JSONv2&sysparm_action=get&sysparm_sys_id={sysId}` */
  jsonApi: string;
  /** XML export: `/{table}.do?XML=&sys_id={sysId}` */
  xmlApi: string;
}

/** Link-type keys in display order. */
export const URL_TYPES: ReadonlyArray<keyof RecordUrls> = [
  'studio',
  'navForm',
  'jsonApi',
  'xmlApi'
];

/** Short, human-facing labels for each link type. */
export const URL_LABELS: Record<keyof RecordUrls, string> = {
  studio: 'Studio',
  navForm: 'Form',
  jsonApi: 'JSON',
  xmlApi: 'XML'
};

/** Emoji prefix for lens titles depending on whether the base URL is set. */
export const OPEN_EMOJI = '🌐';
export const COPY_EMOJI = '📋';

/**
 * Build the four ServiceNow URL variants for a single table/sys_id pair.
 */
export function buildRecordUrls(table: string, sysId: string): RecordUrls {
  return {
    studio: `/sn_glider_app/servicenow_studio.do?table=${table}&sysId=${sysId}`,
    navForm: `/nav_to.do?uri=${table}.do%3Fsys_id%3D${sysId}`,
    jsonApi: `/${table}.do?JSONv2&sysparm_action=get&sysparm_sys_id=${sysId}`,
    xmlApi: `/${table}.do?XML=&sys_id=${sysId}`
  };
}

/**
 * Join an instance base URL with an instance-relative path.
 *
 * Trims trailing slashes from the base and inserts a single `/` separator so
 * `https://example.com` + `nav_to.do?...` stays correct.
 */
export function joinBaseUrl(baseUrl: string, path: string): string {
  if (!baseUrl) {
    return path;
  }
  const host = baseUrl.replace(/\/+$/, '');
  if (path.startsWith('/')) {
    return host + path;
  }
  return host + '/' + path;
}

/** True when `url` is already absolute (can be opened externally as-is). */
export function isAbsoluteUrl(url: string): boolean {
  return /^(https?:)\/\//i.test(url);
}
