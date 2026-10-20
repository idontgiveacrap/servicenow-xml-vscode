/**
 * Read-only `snc` calls for the instance MCP.
 * Stdio server only: no sockets, and no create/update/delete commands.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseCliJson } from '../snc/parse';

const execFileAsync = promisify(execFile);

const PROFILE_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 300_000;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 100;

/** One snc connection profile the instance MCP may use. */
export interface InstanceProfile {
  name: string;
  host?: string;
  username?: string;
  is_default: boolean;
}

/**
 * snc executable from `SNC_PATH`, or `snc` on PATH when unset.
 */
export function sncPathFromEnv(): string {
  const raw = process.env.SNC_PATH?.trim();
  return raw || 'snc';
}

/**
 * Parse `SNC_PROFILE_ALLOWLIST` as a JSON string array.
 * Empty, unset, or `[]` means every snc profile is allowed.
 */
export function profileAllowlistFromEnv(
  raw = process.env.SNC_PROFILE_ALLOWLIST
): string[] | undefined {
  const text = raw?.trim() ?? '';
  if (!text) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`SNC_PROFILE_ALLOWLIST is not valid JSON: ${detail}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('SNC_PROFILE_ALLOWLIST must be a JSON array of profile names');
  }
  const names = parsed
    .map((item) => String(item).trim())
    .filter(Boolean);
  return names.length ? names : undefined;
}

/**
 * Parse `snc configure profile list` stdout into profile rows.
 */
export function parseInstanceProfileList(stdout: string): InstanceProfile[] {
  const parsed = parseCliJson(stdout);
  if (parsed === undefined) {
    throw new Error('no JSON payload in snc output');
  }
  return profilesFromParsed(parsed);
}

/**
 * Keep allowlisted profiles. A missing allowlist returns every row.
 */
export function filterProfiles(
  profiles: InstanceProfile[],
  allow: string[] | undefined
): InstanceProfile[] {
  if (!allow) {
    return profiles;
  }
  const allowed = new Set(allow.map((name) => name.toLowerCase()));
  return profiles.filter((row) => allowed.has(row.name.toLowerCase()));
}

/**
 * Clamp `record_query` limit to 1..100. Non-numeric input uses the default.
 */
export function queryLimit(limit: unknown): number {
  const value = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(value)) {
    return DEFAULT_QUERY_LIMIT;
  }
  return Math.max(1, Math.min(Math.trunc(value), MAX_QUERY_LIMIT));
}

/**
 * Profile name to pass as `--profile`, or undefined to use the CLI default.
 * With an allowlist, an omitted profile is allowed only when exactly one
 * default profile is on that list.
 */
export function resolveProfileName(
  profile: string,
  allow: string[] | undefined,
  profiles: InstanceProfile[]
): string | undefined {
  const requested = profile.trim();
  if (!allow) {
    return requested || undefined;
  }
  const allowed = new Set(allow.map((name) => name.toLowerCase()));
  if (requested) {
    if (!allowed.has(requested.toLowerCase())) {
      throw new Error(
        `profile '${requested}' is not in servicenowXml.snc.mcpProfiles`
      );
    }
    return requested;
  }
  const defaults = profiles.filter((row) => row.is_default).map((row) => row.name);
  if (defaults.length !== 1) {
    throw new Error(
      'CLI default profile is not on the mcpProfiles allowlist or could not be determined; pass profile explicitly'
    );
  }
  return defaults[0];
}

/**
 * Tool payload: the `result` member when snc wraps one, otherwise the document.
 */
export function instanceToolPayload(parsed: unknown): unknown {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'result' in parsed) {
    return (parsed as { result: unknown }).result;
  }
  return parsed;
}

/**
 * List snc profiles, then apply the optional allowlist.
 */
export async function listProfiles(): Promise<InstanceProfile[]> {
  const parsed = await runSnc(['configure', 'profile', 'list'], PROFILE_TIMEOUT_MS);
  return filterProfiles(profilesFromParsed(parsed), profileAllowlistFromEnv());
}

/**
 * Read-only `snc record query`. Returns the unwrapped JSON payload.
 */
export async function recordQuery(args: Record<string, unknown>): Promise<unknown> {
  const tableName = typeof args.table === 'string' ? args.table.trim() : '';
  if (!tableName) {
    throw new Error('table is required');
  }
  const fields =
    typeof args.fields === 'string' && args.fields.trim()
      ? args.fields.trim()
      : 'sys_id';
  const cliArgs = [
    'record',
    'query',
    '--table',
    tableName,
    '--fields',
    fields,
    '--limit',
    String(queryLimit(args.limit))
  ];
  const encoded = typeof args.query === 'string' ? args.query.trim() : '';
  if (encoded) {
    cliArgs.push('--query', encoded);
  }
  const offset = positiveOffset(args.offset);
  if (offset !== undefined) {
    cliArgs.push('--offset', String(offset));
  }
  const resolved = await resolveProfileArg(
    typeof args.profile === 'string' ? args.profile : ''
  );
  if (resolved) {
    cliArgs.push('--profile', resolved);
  }
  return instanceToolPayload(await runSnc(cliArgs, QUERY_TIMEOUT_MS));
}

/**
 * Read-only `snc record get` by sys_id. Returns the unwrapped JSON payload.
 */
export async function recordGet(args: Record<string, unknown>): Promise<unknown> {
  const tableName = typeof args.table === 'string' ? args.table.trim() : '';
  const recordId = typeof args.sys_id === 'string' ? args.sys_id.trim() : '';
  if (!tableName) {
    throw new Error('table is required');
  }
  if (!recordId) {
    throw new Error('sys_id is required');
  }
  const cliArgs = ['record', 'get', '--table', tableName, '--sysid', recordId];
  const resolved = await resolveProfileArg(
    typeof args.profile === 'string' ? args.profile : ''
  );
  if (resolved) {
    cliArgs.push('--profile', resolved);
  }
  return instanceToolPayload(await runSnc(cliArgs, QUERY_TIMEOUT_MS));
}

/**
 * True when snc marks this row as default, or the profile is named default.
 */
function isDefaultProfile(name: string, row: Record<string, unknown>): boolean {
  for (const key of ['default', 'isDefault', 'is_default']) {
    const value = row[key];
    if (
      value === true ||
      value === 1 ||
      (typeof value === 'string' &&
        ['true', '1', 'yes'].includes(value.trim().toLowerCase()))
    ) {
      return true;
    }
  }
  return name === 'default';
}

/**
 * Map a parsed profile-list document into rows. Throws on an unexpected shape.
 */
function profilesFromParsed(parsed: unknown): InstanceProfile[] {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('unexpected snc profile list shape');
  }
  const out: InstanceProfile[] = [];
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!name || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('unexpected snc profile list row');
    }
    const row = value as Record<string, unknown>;
    const item: InstanceProfile = {
      name,
      is_default: isDefaultProfile(name, row)
    };
    if (typeof row.host === 'string' && row.host.trim()) {
      item.host = row.host.trim();
    }
    if (typeof row.username === 'string' && row.username.trim()) {
      item.username = row.username.trim();
    }
    out.push(item);
  }
  return out;
}

/**
 * `--profile` value for a tool call, loading profiles when the allowlist requires it.
 */
async function resolveProfileArg(profile: string): Promise<string | undefined> {
  const allow = profileAllowlistFromEnv();
  const requested = profile.trim();
  if (!allow || requested) {
    return resolveProfileName(profile, allow, []);
  }
  const parsed = await runSnc(['configure', 'profile', 'list'], PROFILE_TIMEOUT_MS);
  const profiles = filterProfiles(profilesFromParsed(parsed), allow);
  return resolveProfileName(profile, allow, profiles);
}

/**
 * Positive offset, or undefined when pagination was not requested.
 */
function positiveOffset(offset: unknown): number | undefined {
  if (offset === undefined || offset === null || offset === '' || offset === 0) {
    return undefined;
  }
  const value = typeof offset === 'number' ? offset : Number(offset);
  if (!Number.isFinite(value)) {
    throw new Error('offset must be an integer');
  }
  if (value <= 0) {
    return undefined;
  }
  return Math.trunc(value);
}

/**
 * Instance error text when snc exits 0 with a failure envelope.
 */
function payloadError(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  const error = obj.error;
  if (error !== undefined && error !== null && error !== '') {
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const detail = (error as Record<string, unknown>).message;
      if (typeof detail === 'string' && detail.trim()) {
        return `instance error: ${detail.trim()}`;
      }
    } else if (typeof error === 'string' && error.trim()) {
      return `instance error: ${error.trim()}`;
    }
    return 'instance returned an error payload';
  }
  if (obj.status !== undefined && obj.status !== 'success') {
    return `instance status ${String(obj.status)}`;
  }
  return undefined;
}

/**
 * Run snc with shared non-interactive JSON flags and return the parsed document.
 */
async function runSnc(args: string[], timeout: number): Promise<unknown> {
  const sncPath = sncPathFromEnv();
  let stdout = '';
  try {
    const result = await execFileAsync(
      sncPath,
      [...args, '--no-interactive', '--no-verbose', '--output', 'json'],
      {
        timeout,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8'
      }
    );
    stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    if (err.code === 'ENOENT') {
      throw new Error(`snc executable not found (${sncPath})`);
    }
    if (err.killed) {
      throw new Error(
        `snc timed out after ${Math.round(timeout / 1000)}s (${args.slice(0, 4).join(' ')})`
      );
    }
    const detail = [err.stderr, err.stdout]
      .filter((part) => typeof part === 'string' && part.trim())
      .join(' ')
      .trim();
    throw new Error(detail || `snc exited (${String(err.code ?? 'error')})`);
  }

  const parsed = parseCliJson(stdout);
  if (parsed === undefined) {
    throw new Error('no JSON payload in snc output');
  }
  const failure = payloadError(parsed);
  if (failure) {
    throw new Error(failure);
  }
  return parsed;
}
