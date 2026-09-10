import {
  Server,
  createMcpHandler,
  type CallToolRequest,
  type Implementation,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';
import type {
  MCPackHandlerContext,
  MCPackServerConfig,
  MCPackServer,
} from './types.js';
import { MCPackEngine } from './core.js';
import { isToolAllowed } from './roles.js';
import { protocolContextFromServerContext } from './mcp/protocol.js';
import { normalizeMCPResult } from './mcp/result.js';

/** Create a stateless MCP 2026-07-28-compatible build-mode server. */
export function createMCPackServer(config: MCPackServerConfig): MCPackServer {
  validateConfig(config);

  const roles = config.roles ? { ...config.roles } : undefined;
  const defaultRole = config.defaultRole;
  const serverInfo: Implementation = { name: config.name, version: config.version };

  if (defaultRole && roles && !roles[defaultRole]) {
    console.warn(
      `MCPack: defaultRole "${defaultRole}" is not defined in roles config. Requests will see no tools.`,
    );
  }

  const dispatch = new Map<
    string,
    (
      args: Record<string, unknown>,
      context: MCPackHandlerContext,
    ) => Promise<unknown>
  >();
  for (const tool of config.tools) {
    if (dispatch.has(tool.name)) {
      console.warn(
        `MCPack: duplicate tool name "${tool.name}" in config.tools. Last definition wins.`,
      );
    }
    dispatch.set(tool.name, tool.handler);
  }

  const tools = config.tools.map(({ handler, ...tool }) => {
    void handler;
    return tool;
  }) as Tool[];
  const engine = new MCPackEngine(tools, config, { stateless: true });

  const buildServer = (): Server => {
    const server = new Server(serverInfo, { capabilities: { tools: {} } });

    server.setRequestHandler('tools/list', async (_request, context) => {
      protocolContextFromServerContext(context);
      return normalizeMCPResult(engine.handleToolsList(), serverInfo) as never;
    });

    server.setRequestHandler('tools/call', async (request, context) =>
      handleToolCall(request, context),
    );

    return server;
  };

  const handleToolCall = async (
    request: CallToolRequest,
    serverContext: ServerContext,
  ): Promise<never> => {
    const protocol = protocolContextFromServerContext(serverContext);
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
      return normalizeMCPResult(errorResult(`Unknown tool: ${name}`), serverInfo) as never;
    }

    const toolHandler = dispatch.get(name);
    if (!toolHandler) {
      return normalizeMCPResult(errorResult(`Unknown tool: ${name}`), serverInfo) as never;
    }

    const handlerContext: MCPackHandlerContext = {
      toolName: name,
      role: defaultRole,
      ...protocol,
    };

    try {
      const result = await toolHandler(args, handlerContext);
      return normalizeMCPResult(result, serverInfo) as never;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return normalizeMCPResult(
        errorResult(`Tool "${name}" failed: ${message}`),
        serverInfo,
      ) as never;
    }
  };

  return {
    server: buildServer(),
    handler: createMcpHandler(buildServer, { legacy: 'reject' }),
    handle: {
      destroy: () => engine.destroy(),
      stats: () => engine.stats(),
    },
  };
}

function errorResult(message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function validateConfig(config: MCPackServerConfig): void {
  if (!config.name) throw new Error('MCPack: config.name is required');
  if (!config.version) throw new Error('MCPack: config.version is required');
  if (!config.tools || config.tools.length === 0) {
    throw new Error(
      'MCPack: config.tools is empty. Provide at least one tool definition.',
    );
  }
}
