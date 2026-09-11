import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MCPToolExecutor,
  connectGitHubFromEnvironment,
  GITHUB_MCP_URL,
} from '../../src/tools/mcp-tool-executor.js';
import { RoutingToolExecutor } from '../../src/tools/routing-tool-executor.js';
import { FakeUpstream, tool, searchResult } from './fake-upstream.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('read-only upstream executor', () => {
  it('discovers once, snapshots schema, maps tickets and dispatches exact name', async () => {
    const peer = new FakeUpstream();
    const executor = await MCPToolExecutor.connect(peer);
    peer.catalog = { tools: [] };
    expect(
      await executor.execute('tickets.search', { query: ' test ' }),
    ).toEqual({
      tickets: [{ ticketId: '12', summary: 'An issue', status: 'open' }],
      count: 1,
    });
    expect(peer.calls()).toHaveLength(1);
    expect(peer.calls()[0]).toMatchObject({
      params: { name: 'search_issues', arguments: { query: 'test' } },
    });
    expect(
      peer.messages.filter((m) => 'method' in m && m.method === 'tools/list'),
    ).toHaveLength(1);
    await executor.close();
  });
  it.each([
    {},
    { query: '' },
    { query: 1 },
    { query: 'x', name: 'create_issue' },
    { query: 'x'.repeat(1025) },
  ])('rejects invalid arguments %j before forwarding', async (args) => {
    const peer = new FakeUpstream();
    const executor = await MCPToolExecutor.connect(peer);
    await expect(executor.execute('tickets.search', args)).rejects.toThrow(
      'Invalid tool arguments',
    );
    expect(peer.calls()).toHaveLength(0);
    await executor.close();
  });
  it('enforces discovered constraints at each execution', async () => {
    const peer = new FakeUpstream();
    const selected = tool();
    selected.inputSchema.properties.query.minLength = 5;
    peer.catalog = { tools: [selected] };
    const executor = await MCPToolExecutor.connect(peer);
    selected.inputSchema.properties.query.minLength = 1;
    await expect(
      executor.execute('tickets.search', { query: 'hi' }),
    ).rejects.toThrow('Invalid tool arguments');
    expect(peer.calls()).toHaveLength(0);
    await executor.close();
  });
  it.each([
    { tools: [] },
    { tools: [tool(), tool()] },
    { tools: [tool()], nextCursor: 'next' },
    { tools: [{ ...tool(), name: 'search_issues_extra' }] },
    { tools: [{ ...tool(), annotations: { readOnlyHint: false } }] },
    {
      tools: [
        {
          ...tool(),
          annotations: { readOnlyHint: true, destructiveHint: true },
        },
      ],
    },
    { tools: [{ ...tool(), inputSchema: { type: 'object' } }] },
    {
      tools: [
        {
          ...tool(),
          inputSchema: {
            ...tool().inputSchema,
            $ref: 'https://evil.test/schema',
          },
        },
      ],
    },
    {
      tools: [
        {
          ...tool(),
          inputSchema: { ...tool().inputSchema, required: ['query', 'other'] },
        },
      ],
    },
    {
      tools: [
        { ...tool(), inputSchema: { ...tool().inputSchema, minimum: 'bad' } },
      ],
    },
    { tools: 'bad' },
  ])('fails startup on unsafe or incompatible catalog %#', async (catalog) => {
    const peer = new FakeUpstream();
    peer.catalog = catalog;
    await expect(MCPToolExecutor.connect(peer)).rejects.toThrow(
      'Read-only MCP integration failed.',
    );
    expect(peer.closed).toBe(true);
    expect(peer.calls()).toHaveLength(0);
  });
  it.each(['start', 'initialize', 'tools/list'])(
    'fails closed on %s connection failure',
    async (method) => {
      const peer = new FakeUpstream();
      peer.failMethod = method;
      await expect(MCPToolExecutor.connect(peer)).rejects.toThrow(
        'Read-only MCP integration failed.',
      );
      expect(peer.closed).toBe(true);
    },
  );
  it('rejects unsupported protocol', async () => {
    const peer = new FakeUpstream();
    peer.protocol = '2099-01-01';
    await expect(MCPToolExecutor.connect(peer)).rejects.toThrow(
      'Read-only MCP integration failed.',
    );
  });
  it.each(['initialize', 'tools/list', 'tools/call'])(
    'bounds and closes a hung %s',
    async (method) => {
      const peer = new FakeUpstream();
      if (method === 'tools/call') {
        const executor = await MCPToolExecutor.connect(peer, 30);
        peer.hangMethod = method;
        await expect(
          executor.execute('tickets.search', { query: 'test' }),
        ).rejects.toThrow('Read-only MCP integration failed.');
        await expect(
          executor.execute('tickets.search', { query: 'test' }),
        ).rejects.toThrow();
        expect(peer.calls()).toHaveLength(1);
      } else {
        peer.hangMethod = method;
        await expect(MCPToolExecutor.connect(peer, 30)).rejects.toThrow(
          'Read-only MCP integration failed.',
        );
      }
      expect(peer.closed).toBe(true);
    },
  );
  it.each([
    {
      isError: true,
      content: [{ type: 'text', text: 'Bearer credential-secret' }],
    },
    { content: 'bad' },
    { content: [{ type: 'text', text: 'not JSON credential-secret' }] },
    { content: [{ type: 'text', text: '{}' }] },
    { content: [] },
    { content: [], structuredContent: { total_count: 1, items: [{}] } },
  ])(
    'rejects error or malformed result %# without exposing content',
    async (result) => {
      const peer = new FakeUpstream();
      peer.result = result;
      const executor = await MCPToolExecutor.connect(peer);
      await expect(
        executor.execute('tickets.search', { query: 'test' }),
      ).rejects.toThrow('Read-only MCP integration failed.');
      expect(peer.closed).toBe(true);
    },
  );
  it('accepts structuredContent and discards extra text and metadata', async () => {
    const peer = new FakeUpstream();
    peer.result = {
      ...searchResult(),
      structuredContent: { total_count: 0, items: [] },
      _meta: { secret: 'hidden' },
    };
    const executor = await MCPToolExecutor.connect(peer);
    expect(await executor.execute('tickets.search', { query: 'test' })).toEqual(
      { tickets: [], count: 0 },
    );
    await executor.close();
  });
  it('routes mocks and rejects all other names exactly', async () => {
    const peer = new FakeUpstream();
    const executor = await MCPToolExecutor.connect(peer);
    const routing = new RoutingToolExecutor(executor);
    expect(
      await routing.execute('refunds.execute', {
        customerId: 'c',
        amount: 10,
        reason: 'test',
      }),
    ).toBeDefined();
    for (const name of [
      'search_issues',
      'tickets.search.extra',
      'create_issue',
    ]) {
      expect(() => routing.validate(name, {})).toThrow('Unknown tool');
      expect(() => routing.execute(name, {})).toThrow('Unknown tool');
      await expect(executor.execute(name, {})).rejects.toThrow('Unknown tool');
    }
    expect(peer.calls()).toHaveLength(0);
    await executor.close();
  });
  it.each([0, -1, NaN, 60001, 1.1])(
    'rejects invalid timeout %s',
    async (timeout) => {
      await expect(
        MCPToolExecutor.connect(new FakeUpstream(), timeout),
      ).rejects.toThrow();
    },
  );
  it('rejects missing credential without network access', async () => {
    vi.stubEnv('GITHUB_PERSONAL_ACCESS_TOKEN', '');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(connectGitHubFromEnvironment()).rejects.toThrow(
      'Read-only MCP integration failed.',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses pinned HTTPS destination, environment credential, readonly and exact tool headers', async () => {
    vi.stubEnv('GITHUB_PERSONAL_ACCESS_TOKEN', 'fake_credential');
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe(GITHUB_MCP_URL);
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('Bearer fake_credential');
      expect(headers.get('x-mcp-readonly')).toBe('true');
      expect(headers.get('x-mcp-tools')).toBe('search_issues');
      expect(init.redirect).toBe('error');
      throw new Error('Bearer fake_credential');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(connectGitHubFromEnvironment()).rejects.toThrow(
      'Read-only MCP integration failed.',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('performs the complete HTTP handshake, discovery and call without network', async () => {
    vi.stubEnv('GITHUB_PERSONAL_ACCESS_TOKEN', 'fake_credential');
    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        if (init.method === 'GET') return new Response(null, { status: 405 });
        const message = JSON.parse(init.body);
        methods.push(message.method);
        if (!('id' in message)) return new Response(null, { status: 202 });
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'fake-http', version: '1' },
              }
            : message.method === 'tools/list'
              ? { tools: [tool()] }
              : searchResult();
        if (message.method === 'tools/call')
          expect(message.params).toEqual({
            name: 'search_issues',
            arguments: { query: 'test' },
          });
        return Response.json({ jsonrpc: '2.0', id: message.id, result });
      }),
    );
    const executor = await connectGitHubFromEnvironment();
    expect(
      await executor.execute('tickets.search', { query: 'test' }),
    ).toMatchObject({ count: 1 });
    expect(methods).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ]);
    await executor.close();
  });
});
