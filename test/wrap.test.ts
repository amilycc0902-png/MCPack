/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-RPC wire assertions */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  Server,
  createMcpHandler,
  inputRequired,
  type McpHttpHandler,
  type Tool,
} from '@modelcontextprotocol/server';
import { mcpack } from '../src/wrap.js';
import type { MCPackWrappedServer } from '../src/types.js';

const TOOLS: Tool[] = [
  {
    name: 'create_customer',
    description: 'Create a new customer record',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'list_payments',
    description: 'List customer payments',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_account',
    description: 'Delete an account',
    inputSchema: { type: 'object', properties: {} },
  },
];

const validMeta = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
};

function upstream(
  call?: (name: string) => unknown,
): McpHttpHandler {
  return createMcpHandler(() => {
    const server = new Server(
      { name: 'upstream-server', version: '2.1.0' },
      { capabilities: { tools: { listChanged: true }, resources: {} } },
    );
    server.setRequestHandler('tools/list', async () => ({ tools: TOOLS }));
    server.setRequestHandler('tools/call', async (request) =>
      (call?.(request.params.name) ?? {
        content: [{ type: 'text', text: `upstream:${request.params.name}` }],
      }) as never,
    );
    return server;
  }, { legacy: 'reject' });
}

async function request(
  handler: McpHttpHandler,
  method: string,
  params: Record<string, unknown> = {},
  meta: Record<string, unknown> = validMeta,
) {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'MCP-Protocol-Version': String(
      meta[PROTOCOL_VERSION_META_KEY] ?? '2026-07-28',
    ),
    'Mcp-Method': method,
  };
  if (method === 'tools/call') headers['Mcp-Name'] = String(params.name);
  const response = await handler.fetch(new Request('http://test.local/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method,
      params: { ...params, _meta: meta },
    }),
  }));
  return { status: response.status, body: await response.json() as any };
}

describe('mcpack() M2 stateless wrap mode', () => {
  let wrapped: MCPackWrappedServer | undefined;

  afterEach(() => {
    wrapped?.handle.destroy();
    wrapped = undefined;
  });

  it('server/discover works first without initialize and merges capabilities', async () => {
    wrapped = await mcpack(upstream());
    const response = await request(wrapped.handler, 'server/discover');

    expect(response.status).toBe(200);
    expect(response.body.result.supportedVersions).toEqual(['2026-07-28']);
    expect(response.body.result.capabilities).toEqual({
      tools: {}, resources: {},
    });
    expect(response.body.result._meta[SERVER_INFO_META_KEY]).toEqual({
      name: 'upstream-server', version: '2.1.0',
    });
    expect(response.body.result.resultType).toBe('complete');
  });

  it('accepts supported metadata and needs neither initialize nor a session ID', async () => {
    wrapped = await mcpack(upstream());
    const response = await request(wrapped.handler, 'tools/list');

    expect(response.status).toBe(200);
    expect(response.body.result.tools.map((tool: Tool) => tool.name)).toEqual([
      'search_tools',
    ]);
    expect(response.body.result.resultType).toBe('complete');
    expect(response.body.result._meta[SERVER_INFO_META_KEY]).toBeDefined();
  });

  it('rejects unsupported protocol versions', async () => {
    wrapped = await mcpack(upstream());
    const response = await request(wrapped.handler, 'tools/list', {}, {
      ...validMeta,
      [PROTOCOL_VERSION_META_KEY]: '2099-01-01',
    });

    expect(response.body.error.code).toBe(-32022);
    expect(response.body.error.data).toEqual({
      requested: '2099-01-01', supported: ['2026-07-28'],
    });
  });

  it('clientInfo cannot grant authorization and denied tools stay opaque', async () => {
    wrapped = await mcpack(upstream(), {
      defaultRole: 'reader',
      roles: { reader: ['list_payments'], admin: '*' },
    });
    const response = await request(
      wrapped.handler,
      'tools/call',
      { name: 'delete_account', arguments: {} },
      {
        ...validMeta,
        [CLIENT_INFO_META_KEY]: { name: 'admin', version: '1' },
      },
    );

    expect(response.body.result.isError).toBe(true);
    expect(response.body.result.content[0].text).toBe(
      'Unknown tool: delete_account',
    );
    expect(JSON.stringify(response.body)).not.toContain('reader');
  });

  it('repeated discovery/search calls are independent of previous calls', async () => {
    wrapped = await mcpack(upstream());
    const search = () => request(wrapped!.handler, 'tools/call', {
      name: 'search_tools', arguments: { query: 'customer' },
    });

    const discoverOne = await request(wrapped.handler, 'server/discover');
    const searchOne = await search();
    await request(wrapped.handler, 'tools/call', {
      name: 'create_customer', arguments: { name: 'Alice' },
    });
    const discoverTwo = await request(wrapped.handler, 'server/discover');
    const searchTwo = await search();

    expect(discoverTwo.body.result).toEqual(discoverOne.body.result);
    expect(searchTwo.body.result).toEqual(searchOne.body.result);
    const payload = JSON.parse(searchTwo.body.result.content[0].text);
    expect(payload.session_id).toBeUndefined();
    expect(payload.tools.every((tool: any) => tool.schema)).toBe(true);
  });

  it('preserves upstream metadata and stamps normal wrapped results', async () => {
    wrapped = await mcpack(upstream(() => ({
      content: [{ type: 'text', text: 'ok' }],
      _meta: { upstreamTrace: 'trace-1' },
    })));
    const response = await request(wrapped.handler, 'tools/call', {
      name: 'create_customer', arguments: { name: 'Alice' },
    });

    expect(response.body.result.resultType).toBe('complete');
    expect(response.body.result._meta.upstreamTrace).toBe('trace-1');
    expect(response.body.result._meta[SERVER_INFO_META_KEY]).toEqual({
      name: 'upstream-server', version: '2.1.0',
    });
  });

  it('preserves wrapped input_required results', async () => {
    wrapped = await mcpack(upstream(() => inputRequired({
      inputRequests: {
        confirm: inputRequired.elicit({
          message: 'Continue?',
          requestedSchema: {
            type: 'object',
            properties: { confirm: { type: 'boolean' } },
            required: ['confirm'],
          },
        }),
      },
    })));
    const response = await request(
      wrapped.handler,
      'tools/call',
      { name: 'create_customer', arguments: { name: 'Alice' } },
      {
        ...validMeta,
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
      },
    );

    expect(response.body.result.resultType).toBe('input_required');
    expect(response.body.result.inputRequests.confirm).toBeDefined();
    expect(response.body.result._meta[SERVER_INFO_META_KEY]).toBeDefined();
  });

  it('preserves role filtering and deterministic ordering', async () => {
    wrapped = await mcpack(upstream(), {
      defaultRole: 'reader', roles: { reader: ['list_payments'] },
    });
    const response = await request(wrapped.handler, 'tools/call', {
      name: 'search_tools',
      arguments: { query: 'account customer payments', limit: 10 },
    });
    const payload = JSON.parse(response.body.result.content[0].text);

    expect(payload.total_available).toBe(1);
    expect(payload.tools.map((tool: Tool) => tool.name)).toEqual(['list_payments']);
  });

  it('does not use the SDK private request-handler map', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/wrap.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('_requestHandlers');
  });
});
