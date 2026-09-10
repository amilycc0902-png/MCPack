import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  Server,
  createMcpHandler,
  type CallToolRequest,
  type ClientCapabilities,
  type Implementation,
  type JSONRPCRequest,
  type McpHttpHandler,
  type ServerCapabilities,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';
import type {
  MCPackConfig,
  MCPackWrappedServer,
  MCPackWrapTarget,
} from './types.js';
import { MCPackEngine } from './core.js';
import { isToolAllowed } from './roles.js';
import { protocolContextFromServerContext } from './mcp/protocol.js';
import { normalizeMCPResult } from './mcp/result.js';

const WRAPPER_CLIENT_INFO: Implementation = {
  name: '@llvs/mcpack',
  version: '1.0.0',
};

/**
 * Compose MCPack in front of a stateless MCP v2 HTTP handler.
 *
 * The v2 SDK deliberately exposes no public handler lookup/replacement API, so
 * M2 wraps at its public request/response boundary instead of mutating Server
 * internals. The returned handler is a new, stateless 2026-07-28 endpoint.
 */
export async function mcpack(
  target: MCPackWrapTarget | McpHttpHandler,
  config: MCPackConfig = {},
): Promise<MCPackWrappedServer> {
  const upstream = isWrapTarget(target) ? target.handler : target;
  if (!upstream || typeof upstream.fetch !== 'function') {
    throw new Error(
      'MCPack: wrap mode requires a v2 McpHttpHandler or { handler } target.',
    );
  }

  const bootstrapMeta = requestMeta({}, WRAPPER_CLIENT_INFO);
  const discover = await invokeUpstream(
    upstream,
    'server/discover',
    {},
    bootstrapMeta,
  );
  const serverInfo = readServerInfo(discover);
  const upstreamCapabilities = readCapabilities(discover);

  let tools: Tool[] = [];
  try {
    const listed = await invokeUpstream(upstream, 'tools/list', {}, bootstrapMeta);
    tools = Array.isArray(listed.tools) ? listed.tools as Tool[] : [];
  } catch {
    tools = (config.tools ?? []) as unknown as Tool[];
  }
  if (tools.length === 0) {
    throw new Error(
      'MCPack: no tools found on upstream server. Ensure tools are registered before calling mcpack().',
    );
  }

  const engine = new MCPackEngine(tools, config, { stateless: true });
  const roles = config.roles ? { ...config.roles } : undefined;
  const defaultRole = config.defaultRole;
  const capabilities = mergeCapabilities(upstreamCapabilities);

  if (defaultRole && roles && !roles[defaultRole]) {
    console.warn(
      `MCPack: defaultRole "${defaultRole}" is not defined in roles config. Requests will see no tools.`,
    );
  }

  const createServer = (): Server => {
    const server = new Server(serverInfo, { capabilities });

    server.setRequestHandler('tools/list', async (_request, context) => {
      protocolContextFromServerContext(context);
      return normalizeMCPResult(engine.handleToolsList(), serverInfo) as never;
    });

    server.setRequestHandler('tools/call', async (request, context) =>
      handleToolCall(request, context),
    );
    server.fallbackRequestHandler = async (request, context) =>
      forwardRequest(request, context);
    return server;
  };

  const forwardRequest = async (
    request: JSONRPCRequest,
    context: ServerContext,
  ): Promise<never> => {
    const protocol = protocolContextFromServerContext(context);
    const params = isRecord(request.params) ? request.params : {};
    const name = typeof params.name === 'string' ? params.name : undefined;
    const result = await invokeUpstream(
      upstream,
      request.method,
      params,
      requestMeta(protocol.clientCapabilities, protocol.clientInfo),
      name,
    );
    return normalizeMCPResult(result, serverInfo) as never;
  };

  const handleToolCall = async (
    request: CallToolRequest,
    context: ServerContext,
  ): Promise<never> => {
    const protocol = protocolContextFromServerContext(context);
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (name === 'search_tools') {
      return normalizeMCPResult(
        engine.handleSearchToolsStateless(args),
        serverInfo,
      ) as never;
    }

    config.onToolCall?.({
      toolName: name,
      arguments: args,
      ...protocol,
      userQuery: args.user_query,
      requestContext: args.request_context,
    });

    if (!isToolAllowed(name, defaultRole, roles)) {
      return normalizeMCPResult(
        opaqueToolError(name),
        serverInfo,
      ) as never;
    }

    try {
      const upstreamResult = await invokeUpstream(
        upstream,
        'tools/call',
        { name, arguments: args },
        requestMeta(protocol.clientCapabilities, protocol.clientInfo),
        name,
      );
      return normalizeMCPResult(upstreamResult, serverInfo) as never;
    } catch {
      return normalizeMCPResult(
        {
          content: [{ type: 'text', text: `Tool "${name}" failed` }],
          isError: true,
        },
        serverInfo,
      ) as never;
    }
  };

  return {
    handler: createMcpHandler(createServer, { legacy: 'reject' }),
    handle: {
      destroy: () => engine.destroy(),
      stats: () => engine.stats(),
    },
  };
}

function requestMeta(
  clientCapabilities: ClientCapabilities,
  clientInfo?: Implementation,
): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_CAPABILITIES_META_KEY]: clientCapabilities,
    ...(clientInfo === undefined ? {} : { [CLIENT_INFO_META_KEY]: clientInfo }),
  };
}

async function invokeUpstream(
  handler: McpHttpHandler,
  method: string,
  params: Record<string, unknown>,
  meta: Record<string, unknown>,
  toolName?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
    ...(toolName === undefined ? {} : { 'Mcp-Name': toolName }),
  };
  const response = await handler.fetch(new Request('http://mcpack.local/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { ...params, _meta: meta },
    }),
  }));
  const payload = await response.json() as {
    result?: Record<string, unknown>;
    error?: { message?: string };
  };
  if (!response.ok || payload.error || !payload.result) {
    throw new Error(payload.error?.message ?? `Upstream ${method} failed`);
  }
  return payload.result;
}

function readServerInfo(discover: Record<string, unknown>): Implementation {
  const meta = isRecord(discover._meta) ? discover._meta : {};
  const info = meta[SERVER_INFO_META_KEY];
  if (!isImplementation(info)) {
    throw new Error('MCPack: upstream server/discover did not identify the server.');
  }
  return info;
}

function readCapabilities(discover: Record<string, unknown>): ServerCapabilities {
  return isRecord(discover.capabilities)
    ? discover.capabilities as ServerCapabilities
    : {};
}

function mergeCapabilities(upstream: ServerCapabilities): ServerCapabilities {
  // MCPack owns tools/list and cannot truthfully forward upstream list-change
  // subscriptions, so it preserves other upstream capabilities but advertises
  // only the compatible tools surface.
  return { ...upstream, tools: {} };
}

function opaqueToolError(name: string) {
  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

function isWrapTarget(value: MCPackWrapTarget | McpHttpHandler): value is MCPackWrapTarget {
  return isRecord(value) && 'handler' in value;
}

function isImplementation(value: unknown): value is Implementation {
  return isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.version === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
