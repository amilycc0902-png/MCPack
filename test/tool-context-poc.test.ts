import { describe, it, expect, afterEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { mcpack } from '../src/wrap.js';
import type { MCPackHandle, MCPackToolCallObservation } from '../src/types.js';

type RawHandler = (request: any, extra: any) => Promise<any>;

function makeExtra(sessionId = 'session-poc') {
  return {
    signal: new AbortController().signal,
    requestId: 1,
    sessionId,
    sendNotification: async () => {},
    sendRequest: async () => {
      throw new Error('not available');
    },
  };
}

function getHandler(server: Server, method: string): RawHandler {
  const handler = (server as any)._requestHandlers?.get(method);
  if (!handler) throw new Error(`No handler for ${method}`);
  return handler;
}

function createServer(tools: Tool[]): Server {
  const server = new Server(
    { name: 'context-poc-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text', text: `called:${request.params.name}` }],
  }));

  return server;
}

describe('tool-call context POC', () => {
  let handle: MCPackHandle | undefined;

  afterEach(() => {
    handle?.destroy();
    handle = undefined;
  });

  it('normal MCP tool calls expose only tool name and arguments to MCPack', async () => {
    const observations: MCPackToolCallObservation[] = [];
    const server = createServer([
      {
        name: 'send_email',
        description: 'Send an email',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            subject: { type: 'string' },
          },
          required: ['to', 'subject'],
        },
      },
    ]);

    handle = await mcpack(server, {
      onToolCall: observation => observations.push(observation),
    });

    const callHandler = getHandler(server, 'tools/call');
    await callHandler(
      {
        method: 'tools/call',
        params: {
          name: 'send_email',
          arguments: { to: 'ops@example.com', subject: 'Status' },
        },
      },
      makeExtra(),
    );

    expect(observations).toEqual([
      {
        toolName: 'send_email',
        arguments: { to: 'ops@example.com', subject: 'Status' },
        sessionId: 'session-poc',
        userQuery: undefined,
        requestContext: undefined,
      },
    ]);
  });

  it('schema-provided user_query or request_context can be logged when the client sends it', async () => {
    const observations: MCPackToolCallObservation[] = [];
    const server = createServer([
      {
        name: 'send_email',
        description: 'Send an email',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            subject: { type: 'string' },
            user_query: { type: 'string' },
            request_context: { type: 'object' },
          },
          required: ['to', 'subject'],
        },
      },
    ]);

    handle = await mcpack(server, {
      onToolCall: observation => observations.push(observation),
    });

    const callHandler = getHandler(server, 'tools/call');
    await callHandler(
      {
        method: 'tools/call',
        params: {
          name: 'send_email',
          arguments: {
            to: 'ops@example.com',
            subject: 'Status',
            user_query: 'Tell ops the rollout is complete',
            request_context: { workflow: 'release', risk: 'low' },
          },
        },
      },
      makeExtra(),
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      toolName: 'send_email',
      sessionId: 'session-poc',
      userQuery: 'Tell ops the rollout is complete',
      requestContext: { workflow: 'release', risk: 'low' },
    });
    expect(observations[0].arguments).toEqual({
      to: 'ops@example.com',
      subject: 'Status',
      user_query: 'Tell ops the rollout is complete',
      request_context: { workflow: 'release', risk: 'low' },
    });
  });
});
