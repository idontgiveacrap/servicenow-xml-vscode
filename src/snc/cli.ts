import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import {
  chunkSysIds,
  parseSncProfileList,
  parseSncRecordQuery,
  type RecordQueryParse,
  type SncProfileInfo
} from './parse';

const execFileAsync = promisify(execFile);

// Every snc invocation pays a round trip to the instance; observed calls take
// roughly 35s, so these sit well above that rather than at a typical CLI budget.
const PROFILE_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 300_000;

/** Configured `snc` executable (PATH name or absolute path). */
export function getSncPath(): string {
  return (
    vscode.workspace
      .getConfiguration('servicenowXml')
      .get<string>('snc.path', 'snc') || 'snc'
  );
}

/**
 * True when the configured `snc` executable can be spawned.
 *
 * Only a spawn failure counts as missing: `snc` has no `--version` flag and
 * answers unknown flags on stdout, so a non-zero exit still proves it is there.
 */
export async function sncIsAvailable(sncPath = getSncPath()): Promise<boolean> {
  try {
    await execFileAsync(sncPath, ['--help'], {
      timeout: 20_000,
      windowsHide: true
    });
    return true;
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    return code !== 'ENOENT' && code !== 'EACCES';
  }
}

/**
 * Load named profiles. Undefined when the CLI fails or JSON is unexpected.
 */
export async function listSncProfiles(
  sncPath = getSncPath()
): Promise<SncProfileInfo[] | undefined> {
  const run = await runSnc(sncPath, ['configure', 'profile', 'list'], PROFILE_TIMEOUT_MS);
  if (!run.ok) {
    return undefined;
  }
  return parseSncProfileList(run.stdout);
}

export type TableQueryOutcome =
  | { ok: true; present: Set<string> }
  | { ok: false; reason: string };

/**
 * Query one table for which of `sysIds` still exist. Fail closed per chunk.
 */
export async function querySysIdsOnTable(args: {
  sncPath?: string;
  table: string;
  sysIds: string[];
  profile?: string;
}): Promise<TableQueryOutcome> {
  const sncPath = args.sncPath ?? getSncPath();
  const present = new Set<string>();
  for (const chunk of chunkSysIds(args.sysIds)) {
    const cliArgs = [
      'record',
      'query',
      '--table',
      args.table,
      '--fields',
      'sys_id',
      '--query',
      `sys_idIN${chunk.join(',')}`,
      '--limit',
      String(chunk.length)
    ];
    if (args.profile) {
      cliArgs.push('--profile', args.profile);
    }
    const run = await runSnc(sncPath, cliArgs, QUERY_TIMEOUT_MS);
    if (!run.ok) {
      return { ok: false, reason: run.reason };
    }
    const parsed: RecordQueryParse = parseSncRecordQuery(run.stdout);
    if (!parsed.ok) {
      return parsed;
    }
    for (const id of parsed.sysIds) {
      present.add(id);
    }
  }
  return { ok: true, present };
}

/**
 * Run `snc` and return stdout, or a reason when the process fails.
 */
async function runSnc(
  sncPath: string,
  args: string[],
  timeout: number
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    args.push('--no-interactive')
    args.push('--no-verbose')
    args.push('--output', 'json')
    const { stdout } = await execFileAsync(sncPath, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
    return { ok: true, stdout: typeof stdout === 'string' ? stdout : String(stdout) };
  } catch (error) {
    const err = error as {
      message?: string;
      stderr?: string;
      stdout?: string;
      code?: string | number;
    };
    const detail = [err.stderr, err.stdout, err.message]
      .filter((part) => typeof part === 'string' && part.trim())
      .join(' ')
      .trim();
    return {
      ok: false,
      reason: detail || `snc exited (${String(err.code ?? 'error')})`
    };
  }
}
