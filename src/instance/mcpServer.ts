/**
 * Node MCP server for read-only ServiceNow instance queries via snc.
 * Stdio transport — no network listeners. No external MCP SDK dependency.
 *
 * Env:
 *   SNC_PATH — snc executable (default `snc` on PATH)
 *   SNC_PROFILE_ALLOWLIST — JSON array of profile names; empty allows every profile
 */

import { runMcpStdio } from '../registry/mcpStdio';
import { listProfiles, recordGet, recordQuery } from './snc';

const tools = [
  {
    name: 'list_profiles',
    description:
      'List snc connection profiles the instance MCP may use. Each row has name, optional host, optional username, and is_default. When servicenowXml.snc.mcpProfiles is a non-empty allowlist, only those names are returned. Unset or empty allowlist returns every snc profile.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'record_query',
    description:
      'Read-only snc record query. Prefer repo and docs/schema MCP first. table is the ServiceNow table name. query is an encoded query (empty returns the first page). fields is a comma-separated column list, default sys_id. limit defaults to 100 and is capped at 100. offset is the starting index. profile is an snc profile name; empty uses the CLI default, which must be on the allowlist when one is set.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        query: { type: 'string' },
        fields: { type: 'string' },
        limit: { type: 'number' },
        offset: { type: 'number' },
        profile: { type: 'string' }
      },
      required: ['table']
    }
  },
  {
    name: 'record_get',
    description:
      'Read-only snc record get by sys_id. Prefer repo source when the record is exported. profile is an snc profile name; empty uses the CLI default, which must be on the allowlist when one is set.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        sys_id: { type: 'string' },
        profile: { type: 'string' }
      },
      required: ['table', 'sys_id']
    }
  }
];

/**
 * Dispatch one instance MCP tool. Unknown names throw.
 */
async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (name === 'list_profiles') {
    return listProfiles();
  }
  if (name === 'record_query') {
    return recordQuery(args);
  }
  if (name === 'record_get') {
    return recordGet(args);
  }
  throw new Error(`Unknown tool: ${name}`);
}

runMcpStdio({
  name: 'servicenow-xml-instance',
  version: '1.0.0',
  tools,
  callTool
});
