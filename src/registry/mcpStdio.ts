/**
 * Minimal MCP stdio JSON-RPC framing (no external MCP SDK dependency).
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Handler = (params: unknown) => Promise<unknown> | unknown;

/**
 * Run an MCP-compatible stdio server with Content-Length framing and a
 * newline-delimited fallback for simple hosts.
 */
export function runMcpStdio(handlers: {
  name: string;
  version: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}): void {
  const methodHandlers: Record<string, Handler> = {
    initialize: () => ({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: handlers.name, version: handlers.version }
    }),
    'notifications/initialized': () => null,
    'tools/list': () => ({ tools: handlers.tools }),
    'tools/call': async (params) => {
      const p = params as { name?: string; arguments?: Record<string, unknown> };
      const toolName = p.name ?? '';
      try {
        const result = await handlers.callTool(toolName, p.arguments ?? {});
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
          isError: true
        };
      }
    },
    ping: () => ({})
  };

  let buffer = Buffer.alloc(0);

  const respond = (response: JsonRpcResponse): void => {
    const body = Buffer.from(JSON.stringify(response), 'utf8');
    const header = Buffer.from(
      `Content-Length: ${body.length}\r\n\r\n`,
      'utf8'
    );
    process.stdout.write(Buffer.concat([header, body]));
  };

  const handleMessage = async (message: JsonRpcRequest): Promise<void> => {
    if (message.method?.startsWith('notifications/')) {
      const handler = methodHandlers[message.method];
      if (handler) {
        await handler(message.params);
      }
      return;
    }
    const id = message.id ?? null;
    const handler = methodHandlers[message.method];
    if (!handler) {
      respond({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${message.method}` }
      });
      return;
    }
    try {
      const result = await handler(message.params);
      if (id !== null && id !== undefined) {
        respond({ jsonrpc: '2.0', id, result });
      }
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      respond({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: errMessage }
      });
    }
  };

  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    void drain();
  });

  async function drain(): Promise<void> {
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        // Newline-delimited JSON fallback (single object per line).
        const nl = buffer.indexOf('\n');
        if (nl === -1) {
          return;
        }
        const line = buffer.slice(0, nl).toString('utf8').trim();
        buffer = buffer.slice(nl + 1);
        if (!line || line.startsWith('Content-Length:')) {
          continue;
        }
        try {
          await handleMessage(JSON.parse(line) as JsonRpcRequest);
        } catch (error) {
          console.error('[registry-mcp] bad line:', error);
        }
        continue;
      }

      const header = buffer.slice(0, headerEnd).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) {
        return;
      }
      const body = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.slice(bodyStart + length);
      try {
        await handleMessage(JSON.parse(body) as JsonRpcRequest);
      } catch (error) {
        console.error('[registry-mcp] bad message:', error);
      }
    }
  }

  process.stdin.resume();
}
