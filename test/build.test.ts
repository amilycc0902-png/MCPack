/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-RPC wire assertions */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
} from '@modelcontextprotocol/server';
import { createMCPackServer } from '../src/build.js';
import type {
  MCPackHandlerContext,
  MCPackServer,
  MCPackServerConfig,
  MCPackToolDefinition,
} from '../src/types.js';

const TOOLS: MCPackToolDefinition[] = [
  {
    name: 'create_customer',
    description: 'Create a new customer record',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    handler: async (args) => `created:${args.name}`,
  },
  {
    name: 'list_payments',
    description: 'List customer payments',
    inputSchema: {
      type: 'object',
      properties: { customerId: { type: 'string' } },
    },
    handler: async () => 'payments',
  },
  {
    name: 'delete_account',
    description: 'Delete an account',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => 'deleted',
  },
];

function config(overrides: Partial<MCPackServerConfig> = {}): MCPackServerConfig {
  return { name: 'test-server', version: '1.0.0', tools: TOOLS, ...overrides };
}

const validMeta = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
};

async function request(
  server: MCPackServer,
  method: string,
  params: Record<string, unknown> = {},
  meta: Record<string, unknown> | undefined = validMeta,
) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: { ...params, ...(meta === undefined ? {} : { _meta: meta }) },
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version':
      typeof meta?.[PROTOCOL_VERSION_META_KEY] === 'string'
        ? String(meta[PROTOCOL_VERSION_META_KEY])
        : '2026-07-28',
    'Mcp-Method': method,
  };
  if (method === 'tools/call') {
    headers['Mcp-Name'] = String(params.name);
  }
  const response = await server.handler.fetch(
    new Request('http://test.local/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as any };
}

describe('createMCPackServer() M1 build mode', () => {
  let built: MCPackServer | undefined;

  afterEach(() => {
    built?.handle.destroy();
    built = undefined;
  });

  it('server/discover works as the first request without initialize', async () => {
    built = createMCPackServer(config());
    const response = await request(built, 'server/discover');

    expect(response.status).toBe(200);
    expect(response.body.result.supportedVersions).toEqual(['2026-07-28']);
    expect(response.body.result.capabilities).toEqual({ tools: {} });
    expect(response.body.result.resultType).toBe('complete');
    expect(response.body.result._meta[SERVER_INFO_META_KEY]).toEqual({
      name: 'test-server',
      version: '1.0.0',
    });
  });

  it('accepts supported per-request metadata and needs no session ID', async () => {
    built = createMCPackServer(config());
    const response = await request(built, 'tools/call', {
      name: 'search_tools',
      arguments: { query: 'customer' },
    });

    expect(response.status).toBe(200);
    expect(response.body.result.resultType).toBe('complete');
    expect(response.body.result._meta[SERVER_INFO_META_KEY]).toBeDefined();
    const search = JSON.parse(response.body.result.content[0].text);
    expect(search.session_id).toBeUndefined();
    expect(search.tools.every((tool: any) => tool.schema)).toBe(true);
  });

  it('rejects an unsupported protocol version', async () => {
    built = createMCPackServer(config());
    const response = await request(built, 'tools/list', {}, {
      ...validMeta,
      [PROTOCOL_VERSION_META_KEY]: '2099-01-01',
    });

    expect(response.body.error.code).toBe(-32022);
    expect(response.body.error.data).toEqual({
      requested: '2099-01-01',
      supported: ['2026-07-28'],
    });
  });

  it('rejects missing required request metadata', async () => {
    built = createMCPackServer(config());
    const missingVersion = await request(built, 'tools/list', {}, {
      [CLIENT_CAPABILITIES_META_KEY]: {},
    });
    const missingCapabilities = await request(built, 'tools/list', {}, {
      [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    });

    expect(missingVersion.body.error).toBeDefined();
    expect(missingCapabilities.body.error).toBeDefined();
  });

  it('clientInfo is attribution only and cannot grant authorization', async () => {
    built = createMCPackServer(config({
      defaultRole: 'reader',
      roles: { reader: ['list_payments'], admin: '*' },
    }));
    const response = await request(
      built,
      'tools/call',
      { name: 'delete_account', arguments: {} },
      {
        ...validMeta,
        [CLIENT_INFO_META_KEY]: { name: 'admin', version: '1.0.0' },
      },
    );

    expect(response.body.result.isError).toBe(true);
    expect(response.body.result.content[0].text).toBe(
      'Unknown tool: delete_account',
    );
  });

  it('identical searches are equivalent regardless of previous calls', async () => {
    built = createMCPackServer(config());
    const search = () => request(built!, 'tools/call', {
      name: 'search_tools',
      arguments: { query: 'customer' },
    });

    const first = await search();
    await request(built, 'tools/call', {
      name: 'create_customer',
      arguments: { name: 'Alice' },
    });
    const second = await search();

    expect(second.body.result).toEqual(first.body.result);
  });

  it('preserves existing role filtering in stateless search', async () => {
    built = createMCPackServer(config({
      defaultRole: 'reader',
      roles: { reader: ['list_payments'] },
    }));
    const response = await request(built, 'tools/call', {
      name: 'search_tools',
      arguments: { query: 'customer payments account', limit: 10 },
    });
    const search = JSON.parse(response.body.result.content[0].text);

    expect(search.total_available).toBe(1);
    expect(search.tools.map((tool: any) => tool.name)).toEqual(['list_payments']);
  });

  it('passes request-scoped protocol context without a session field', async () => {
    let captured: MCPackHandlerContext | undefined;
    const tool: MCPackToolDefinition = {
      name: 'context',
      description: 'Capture context',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, context) => {
        captured = context;
        return { content: [{ type: 'text', text: 'ok' }], _meta: { upstream: true } };
      },
    };
    built = createMCPackServer(config({ tools: [tool] }));
    const response = await request(built, 'tools/call', {
      name: 'context', arguments: {},
    });

    expect(captured).toMatchObject({
      toolName: 'context', protocolVersion: '2026-07-28', clientCapabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    expect(captured).not.toHaveProperty('sessionId');
    expect(response.body.result._meta.upstream).toBe(true);
    expect(response.body.result.resultType).toBe('complete');
  });
});
