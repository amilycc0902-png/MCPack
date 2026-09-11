import { afterEach, expect, it, vi } from 'vitest';
import {
  formatDemoFailure,
  isLiveSuccess,
  runRealMCPDemo,
} from '../../src/demo/real-mcp-diagnostics.js';
import { createRealMCPPilot } from '../../src/demo/real-mcp-composition.js';
import {
  MCPToolExecutor,
  connectGitHubFromEnvironment,
} from '../../src/tools/mcp-tool-executor.js';
import type { ToolCallServiceResponse } from '../../src/gateway/types.js';
import { FakeUpstream, tool } from '../tools/fake-upstream.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  compileTicketSchema,
  formatKeywordDiagnostic,
} from '../../src/tools/upstream-schema.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const secret =
  'Bearer token-secret upstream-message issue-title audit-secret stack-secret';

it.each(['Authorization', 'X-Annotation-Only'])(
  'keeps caller arguments and transport headers unchanged, case %#',
  async (headerName) => {
    vi.stubEnv('GITHUB_PERSONAL_ACCESS_TOKEN', 'fake_token_secret');
    vi.stubEnv(headerName, 'must-not-be-read');
    const calls: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        if (init.method === 'GET') return new Response(null, { status: 405 });
        const request = JSON.parse(init.body);
        const headers = new Headers(init.headers);
        expect(headers.get('authorization')).toBe('Bearer fake_token_secret');
        expect(headers.get('x-mcp-readonly')).toBe('true');
        expect(headers.get('x-mcp-tools')).toBe('search_issues');
        if (headerName !== 'Authorization')
          expect(headers.has(headerName)).toBe(false);
        expect([...headers.values()].join(' ')).not.toContain(
          'must-not-be-read',
        );
        expect([...headers.values()].join(' ')).not.toContain(
          'default-must-not-be-forwarded',
        );
        if (!('id' in request)) return new Response(null, { status: 202 });
        let result: unknown;
        if (request.method === 'initialize')
          result = {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1' },
          };
        else if (request.method === 'tools/list')
          result = {
            tools: [
              {
                ...tool(),
                inputSchema: {
                  ...tool().inputSchema,
                  properties: {
                    query: { type: 'string' },
                    optionalInput: {
                      type: 'string',
                      'x-mcp-header': headerName,
                      default: 'default-must-not-be-forwarded',
                    },
                  },
                },
              },
            ],
          };
        else {
          calls.push(request.params);
          result = {
            content: [],
            structuredContent: { total_count: 0, items: [] },
          };
        }
        return Response.json({ jsonrpc: '2.0', id: request.id, result });
      }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observer = vi.fn();
    const upstream = await connectGitHubFromEnvironment(observer);
    try {
      const pilot = createRealMCPPilot(upstream);
      const request = {
        requestId: 'annotation-test',
        userId: 'support',
        userRole: 'support-agent',
        agentId: 'agent',
        toolName: 'tickets.search',
        arguments: { query: 'test' },
      };
      const invalid = await pilot.toolCallService.handle({
        ...request,
        arguments: { query: 'test', optionalInput: 'caller-header' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(calls).toHaveLength(0);
      const allowed = await pilot.toolCallService.handle(request);
      expect(allowed.statusCode).toBe(200);
      expect(allowed.body.decision).toBe('allow');
      expect(calls).toEqual([
        { name: 'search_issues', arguments: { query: 'test' } },
      ]);
      expect(JSON.stringify(observer.mock.calls)).not.toContain(headerName);
      expect(JSON.stringify(pilot.sink.getEvents())).not.toContain(
        'default-must-not-be-forwarded',
      );
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await upstream.close();
    }
  },
);

const headerLocations = [
  'schema_root',
  'query_property_schema',
  'other_property_schema',
  'array_item_schema',
  'nested_schema',
] as const;
const headerValues = [
  ['boolean', true],
  ['string', secret],
  ['number', 314159],
  ['object', { [secret]: secret }],
  ['array', [secret, { [secret]: secret }]],
  ['null', null],
] as const;
function headerSchema(location: string, value: unknown) {
  const extension = { type: 'string', 'x-mcp-header': value };
  const base = tool().inputSchema;
  if (location === 'schema_root') return { ...base, 'x-mcp-header': value };
  if (location === 'query_property_schema')
    return { ...base, properties: { query: extension } };
  const child =
    location === 'array_item_schema'
      ? { type: 'array', items: extension }
      : location === 'nested_schema'
        ? { type: 'object', properties: { [secret]: extension } }
        : extension;
  return {
    ...base,
    properties: { query: { type: 'string' }, [secret]: child },
  };
}

it.each(
  headerLocations.flatMap((location) =>
    headerValues.map(([type, value]) => ({ location, type, value })),
  ),
)(
  'prints only the two header diagnostic categories, case %#',
  async ({ location, type, value }) => {
    vi.stubEnv('GITHUB_PERSONAL_ACCESS_TOKEN', 'fake_token_secret');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        if (init.method === 'GET') return new Response(null, { status: 405 });
        const request = JSON.parse(init.body);
        if (!('id' in request)) return new Response(null, { status: 202 });
        const result =
          request.method === 'initialize'
            ? {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'fake', version: '1' },
              }
            : {
                tools: [
                  {
                    ...tool(),
                    description: secret,
                    inputSchema: headerSchema(location, value),
                  },
                ],
              };
        return Response.json({ jsonrpc: '2.0', id: request.id, result });
      }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      vi.resetModules();
      await import('../../src/demo/real-mcp-pilot.js');
      expect(error.mock.calls).toEqual([
        [`x_mcp_header_location=${location}\nx_mcp_header_value_type=${type}`],
      ]);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
    }
  },
);

it('does not print arbitrary header locations or type labels even with an origin marker', () => {
  const observer = vi.fn();
  expect(() =>
    compileTicketSchema(headerSchema('schema_root', secret), observer),
  ).toThrow('Read-only MCP integration failed.');
  const candidate = observer.mock.calls[0][1];
  for (const value of [
    secret,
    'schema_root\n' + secret,
    {},
    [],
    null,
    undefined,
    'SCHEMA_ROOT',
  ]) {
    expect(formatKeywordDiagnostic({ ...candidate, location: value })).toBe(
      'unsupported_keyword_other',
    );
    expect(formatKeywordDiagnostic({ ...candidate, valueType: value })).toBe(
      'unsupported_keyword_other',
    );
  }
  expect(
    formatKeywordDiagnostic({
      keyword: 'x-mcp-header',
      location: 'schema_root',
      valueType: 'string',
    }),
  ).toBe('unsupported_keyword_other');
});

it.each([undefined, Infinity, NaN, 1n])(
  'does not expose non-JSON header values, case %#',
  (value) => {
    const observer = vi.fn();
    expect(() =>
      compileTicketSchema(headerSchema('schema_root', value), observer),
    ).toThrow('Read-only MCP integration failed.');
    expect(formatKeywordDiagnostic(observer.mock.calls[0][1])).toBe(
      'unsupported_keyword_other',
    );
  },
);

it('keeps header rejection generic in production and never treats a property name as the keyword', async () => {
  const peer = new FakeUpstream();
  peer.catalog = {
    tools: [{ ...tool(), inputSchema: headerSchema('schema_root', secret) }],
  };
  await expect(MCPToolExecutor.connect(peer)).rejects.toThrow(
    'Read-only MCP integration failed.',
  );
  expect(peer.calls()).toHaveLength(0);
  const observer = vi.fn();
  compileTicketSchema(
    {
      ...tool().inputSchema,
      properties: {
        query: { type: 'string' },
        'x-mcp-header': { type: 'string' },
      },
    },
    observer,
  );
  expect(observer).not.toHaveBeenCalled();
});

it('reports only the first occurrence of the unsupported keyword', () => {
  const observer = vi.fn();
  expect(() =>
    compileTicketSchema(
      {
        ...headerSchema('query_property_schema', false),
        'x-mcp-header': secret,
      },
      observer,
    ),
  ).toThrow('Read-only MCP integration failed.');
  expect(formatKeywordDiagnostic(observer.mock.calls[0][1])).toBe(
    'x_mcp_header_location=query_property_schema\nx_mcp_header_value_type=boolean',
  );
});

it.each([undefined, ''])(
  'prints only the environment category when the token is missing, case %#',
  async (token) => {
    vi.stubEnv('GITHUB_PERSONAL_ACCESS_TOKEN', token);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      vi.resetModules();
      await import('../../src/demo/real-mcp-pilot.js');
      expect(error.mock.calls).toEqual([['environment_configuration_failed']]);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      await expect(connectGitHubFromEnvironment()).rejects.toThrow(
        'Read-only MCP integration failed.',
      );
    } finally {
      process.exitCode = exitCode;
    }
  },
);

const keywordCases = [
  '$id',
  '$defs',
  'definitions',
  '$ref',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'const',
  'pattern',
  'format',
  'examples',
  'minProperties',
  'maxProperties',
  'multipleOf',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'dependentRequired',
  'patternProperties',
  '$anchor',
  '$dynamicAnchor',
  '$dynamicRef',
  '$comment',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
  'prefixItems',
  'contains',
  'minContains',
  'maxContains',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  'readOnly',
  'writeOnly',
  'deprecated',
  'nullable',
  'discriminator',
  'externalDocs',
  'xml',
];
it.each([
  ...keywordCases,
  secret,
  '$ref\n' + secret,
  'Pattern',
  'format ',
  '\u001b[31mformat',
  '__proto__',
  'constructor',
  'toString',
  'x-custom',
  'readOnly-secret',
  '$dynamicRef ',
  'Nullable',
  'xml\n' + secret,
  '',
  'a'.repeat(32),
  '$' + 'a'.repeat(32),
  'a'.repeat(33),
  '$' + 'a'.repeat(33),
  'secret.example',
  'https://secret',
  'secret/value',
  'secret:value',
  'x\n',
  'x\r',
  'x\t',
  'x\0',
  'x\u007f',
  'é',
  '关键字',
  'x😀',
  '$$',
  'x$y',
])('prints only the safe schema key or fallback, case %#', async (key) => {
  vi.stubEnv('GITHUB_PERSONAL_ACCESS_TOKEN', 'fake_token_secret');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      if (init.method === 'GET') return new Response(null, { status: 405 });
      const request = JSON.parse(init.body);
      if (!('id' in request)) return new Response(null, { status: 202 });
      const result =
        request.method === 'initialize'
          ? {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'fake', version: '1' },
            }
          : {
              tools: [
                {
                  ...tool(),
                  description: secret,
                  inputSchema: {
                    ...tool().inputSchema,
                    properties: {
                      query: { type: 'string', [key]: secret },
                    },
                  },
                },
              ],
            };
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    }),
  );
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const exitCode = process.exitCode;
  try {
    vi.resetModules();
    await import('../../src/demo/real-mcp-pilot.js');
    expect(error.mock.calls).toEqual([
      [
        /^[$]?[A-Za-z][A-Za-z0-9_-]{0,31}$/.exec(key)?.[0] === key
          ? `unsupported_schema_keyword=${key}`
          : 'unsupported_keyword_other',
      ],
    ]);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = exitCode;
  }
});

it.each([
  secret,
  { toString: () => secret },
  ['format'],
  null,
  undefined,
  'FORMAT',
])('rejects unchecked keyword diagnostic values, case %#', (keyword) => {
  expect(formatDemoFailure('unsupported_schema_keyword', keyword)).toBe(
    'unsupported_keyword_other',
  );
});

it.each([
  [401, 'upstream_http_401'],
  [403, 'upstream_http_403'],
  [404, 'upstream_http_404'],
  [400, 'upstream_http_other'],
  [429, 'upstream_http_other'],
  [500, 'upstream_http_other'],
  [302, 'upstream_http_other'],
] as const)(
  'prints only %s HTTP category through the live entry point',
  async (status, category) => {
    vi.stubEnv('GITHUB_PERSONAL_ACCESS_TOKEN', 'fake_token_secret');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(secret, {
            status,
            statusText: 'upstream-message-secret',
            headers: { 'X-Secret': secret },
          }),
      ),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      vi.resetModules();
      await import('../../src/demo/real-mcp-pilot.js');
      expect(error.mock.calls).toEqual([[category]]);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
    }
  },
);

it.each([401, 403, 404, 418, 503, 999])(
  'maps only the SDK numeric HTTP status %s',
  async (status) => {
    const peer = new FakeUpstream();
    peer.start = async () => {
      throw new StreamableHTTPError(status, secret);
    };
    expect(
      await runRealMCPDemo({
        connect: (observer) => MCPToolExecutor.connect(peer, 1000, observer),
      }),
    ).toEqual({
      exitCode: 1,
      message: [401, 403, 404].includes(status)
        ? `upstream_http_${status}`
        : 'upstream_http_other',
    });
    const normal = new FakeUpstream();
    normal.start = async () => {
      throw new StreamableHTTPError(status, secret);
    };
    await expect(MCPToolExecutor.connect(normal)).rejects.toThrow(
      'Read-only MCP integration failed.',
    );
  },
);

it.each([
  'network',
  'tls',
  'bad_json',
  'bad_content_type',
  'unsupported_protocol',
  'rpc_error',
])('prints no secrets for %s', async (mode) => {
  vi.stubEnv('GITHUB_PERSONAL_ACCESS_TOKEN', 'fake_token_secret');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      if (mode === 'network' || mode === 'tls')
        throw new TypeError(secret, {
          cause: new Error(
            'https://token:secret@example.test upstream-message',
          ),
        });
      if (mode === 'bad_json')
        return new Response(secret, {
          headers: { 'content-type': 'application/json' },
        });
      if (mode === 'bad_content_type')
        return new Response(secret, {
          headers: { 'content-type': 'text/plain' },
        });
      const request = JSON.parse(init.body);
      if (mode === 'rpc_error')
        return Response.json({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32603, message: secret, data: { token: secret } },
        });
      return Response.json({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2099-01-01',
          capabilities: {},
          serverInfo: { name: secret, version: secret },
        },
      });
    }),
  );
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const exitCode = process.exitCode;
  try {
    vi.resetModules();
    await import('../../src/demo/real-mcp-pilot.js');
    expect(error.mock.calls).toEqual([
      [
        mode === 'network' || mode === 'tls'
          ? 'network_or_tls_failed'
          : 'mcp_handshake_failed',
      ],
    ]);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = exitCode;
  }
});

it('does not interpret raw error text or untyped status-looking fields', async () => {
  const peer = new FakeUpstream();
  peer.start = async () => {
    throw Object.assign(new Error('HTTP 401 ' + secret), {
      status: 401,
      code: 403,
    });
  };
  expect(
    await runRealMCPDemo({
      connect: (observer) => MCPToolExecutor.connect(peer, 1000, observer),
    }),
  ).toEqual({ exitCode: 1, message: 'mcp_handshake_failed' });
});

it('classifies malformed MCP result envelopes without exposing SDK validation details', async () => {
  const peer = new FakeUpstream();
  peer.result = { content: secret };
  expect(
    await runRealMCPDemo({
      connect: (observer) => MCPToolExecutor.connect(peer, 1000, observer),
    }),
  ).toEqual({ exitCode: 1, message: 'result_validation_failed' });
});

it.each([
  [
    'mcp_handshake_failed',
    (peer: FakeUpstream) => {
      peer.failMethod = 'start';
    },
  ],
  [
    'capability_validation_failed',
    (peer: FakeUpstream) => {
      peer.capabilities = {};
    },
  ],
  [
    'tool_discovery_failed',
    (peer: FakeUpstream) => {
      peer.catalog = { tools: [], secret };
    },
  ],
  [
    'tool_annotation_failed',
    (peer: FakeUpstream) => {
      peer.catalog = {
        tools: [
          {
            ...tool(),
            annotations: { readOnlyHint: false },
            description: secret,
          },
        ],
      };
    },
  ],
  [
    'unsupported_schema_keyword=format',
    (peer: FakeUpstream) => {
      peer.catalog = {
        tools: [
          {
            ...tool(),
            inputSchema: {
              ...tool().inputSchema,
              description: secret,
              format: secret,
            },
          },
        ],
      };
    },
  ],
  [
    'tool_execution_failed',
    (peer: FakeUpstream) => {
      peer.result = {
        isError: true,
        content: [{ type: 'text', text: secret }],
      };
    },
  ],
  [
    'tool_execution_failed',
    (peer: FakeUpstream) => {
      peer.rpcError = true;
    },
  ],
  [
    'result_validation_failed',
    (peer: FakeUpstream) => {
      peer.result = { content: [{ type: 'text', text: secret }] };
    },
  ],
  [
    'result_validation_failed',
    (peer: FakeUpstream) => {
      peer.result = {
        content: [],
        structuredContent: { items: [{ title: secret }] },
      };
    },
  ],
] as const)(
  'reports only %s through the actual demo path',
  async (expected, configure) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const peer = new FakeUpstream();
    configure(peer);
    const outcome = await runRealMCPDemo({
      connect: (observer) => MCPToolExecutor.connect(peer, 1000, observer),
    });
    expect(outcome).toEqual({ exitCode: 1, message: expected });
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(peer.closed).toBe(true);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  },
);

it('reports policy_denied without audit data or upstream execution', async () => {
  const peer = new FakeUpstream();
  const outcome = await runRealMCPDemo({
    connect: (observer) => MCPToolExecutor.connect(peer, 1000, observer),
    createPilot: (executor) => {
      const pilot = createRealMCPPilot(executor);
      const original = pilot.toolCallService.handle.bind(pilot.toolCallService);
      vi.spyOn(pilot.toolCallService, 'handle').mockImplementation((request) =>
        original({ ...request, userRole: 'unknown' }),
      );
      return pilot;
    },
  });
  expect(outcome).toEqual({ exitCode: 1, message: 'policy_denied' });
  expect(peer.calls()).toHaveLength(0);
});

it('accepts only real successful execution and never includes returned issue data', async () => {
  const peer = new FakeUpstream();
  peer.result = {
    content: [],
    structuredContent: {
      total_count: 1,
      items: [{ id: 1, title: secret, state: 'open' }],
    },
  };
  const outcome = await runRealMCPDemo({
    connect: (observer) => MCPToolExecutor.connect(peer, 1000, observer),
  });
  expect(outcome).toEqual({ exitCode: 0, message: 'Live search succeeded' });
  expect(peer.calls()).toHaveLength(1);
});

it('rejects a 200/allow response when execution never occurred', async () => {
  const peer = new FakeUpstream();
  const outcome = await runRealMCPDemo({
    connect: (observer) => MCPToolExecutor.connect(peer, 1000, observer),
    createPilot: (executor) => {
      const pilot = createRealMCPPilot(executor);
      vi.spyOn(pilot.toolCallService, 'handle').mockResolvedValue({
        statusCode: 200,
        body: { decision: 'allow', executed: true, secret },
      });
      return pilot;
    },
  });
  expect(outcome).toEqual({ exitCode: 1, message: 'result_validation_failed' });
  expect(peer.calls()).toHaveLength(0);
});

it('rejects duplicate successful executions even with status 200 and decision allow', async () => {
  const peer = new FakeUpstream();
  const outcome = await runRealMCPDemo({
    connect: (observer) => MCPToolExecutor.connect(peer, 1000, observer),
    createPilot: (executor) => {
      const pilot = createRealMCPPilot(executor);
      vi.spyOn(pilot.toolCallService, 'handle').mockImplementation(
        async (request) => {
          await executor.execute('tickets.search', request.arguments);
          await executor.execute('tickets.search', request.arguments);
          return { statusCode: 200, body: { decision: 'allow' } };
        },
      );
      return pilot;
    },
  });
  expect(outcome).toEqual({ exitCode: 1, message: 'result_validation_failed' });
  expect(peer.calls()).toHaveLength(2);
});

it.each([
  [200, 'allow', true, true],
  [200, 'deny', true, false],
  [200, undefined, true, false],
  [202, 'allow', true, false],
  [500, 'allow', true, false],
  [200, 'allow', false, false],
  [200, 'allow', undefined, false],
  [200, 'allow', 'true', false],
] as const)(
  'requires all three success checks (%s, %s, %s)',
  (statusCode, decision, executed, expected) => {
    expect(
      isLiveSuccess(
        { statusCode, body: { decision } } as ToolCallServiceResponse,
        executed,
      ),
    ).toBe(expected);
  },
);

it.each([secret, new Error(secret), { stage: secret }, undefined])(
  'never formats unchecked values %#',
  (value) => {
    expect(formatDemoFailure(value)).toBe('tool_execution_failed');
  },
);

it('keeps generic production errors and ignores observer exceptions', async () => {
  const peer = new FakeUpstream();
  peer.failMethod = 'start';
  await expect(
    MCPToolExecutor.connect(peer, 1000, () => {
      throw new Error(secret);
    }),
  ).rejects.toThrow('Read-only MCP integration failed.');
  const working = new FakeUpstream();
  const upstream = await MCPToolExecutor.connect(working, 1000, () => {
    throw new Error(secret);
  });
  working.rpcError = true;
  const response = await createRealMCPPilot(upstream).toolCallService.handle({
    requestId: 'safe',
    userId: 'support',
    userRole: 'support-agent',
    agentId: 'agent',
    toolName: 'tickets.search',
    arguments: { query: 'test' },
  });
  expect(response.body.error).toBe('Mock tool execution failed.');
  expect(response.body).not.toHaveProperty('stage');
});

it('keeps credential and cleanup failures safe', async () => {
  vi.stubEnv('GITHUB_PERSONAL_ACCESS_TOKEN', '');
  expect(await runRealMCPDemo()).toEqual({
    exitCode: 1,
    message: 'environment_configuration_failed',
  });
  const outcome = await runRealMCPDemo({
    connect: async () => ({
      execute: async () => {
        throw new Error(secret);
      },
      close: async () => {
        throw new Error(secret);
      },
    }),
  });
  expect(outcome).toEqual({ exitCode: 1, message: 'tool_execution_failed' });
});
