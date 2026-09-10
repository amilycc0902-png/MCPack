import { describe, expect, it } from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  Server,
  createMcpHandler,
} from '@modelcontextprotocol/server';
import { mcpack } from '../src/wrap.js';
import type { MCPackToolCallObservation } from '../src/types.js';

describe('stateless wrapped tool-call context', () => {
  it('reports request-scoped protocol attribution without session identity', async () => {
    const observations: MCPackToolCallObservation[] = [];
    const upstream = createMcpHandler(() => {
      const server = new Server(
        { name: 'context-server', version: '1.0.0' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler('tools/list', async () => ({
        tools: [{
          name: 'send_email',
          description: 'Send an email',
          inputSchema: { type: 'object', properties: {} },
        }],
      }));
      server.setRequestHandler('tools/call', async () => ({
        content: [{ type: 'text', text: 'sent' }],
      }));
      return server;
    }, { legacy: 'reject' });
    const wrapped = await mcpack(upstream, {
      onToolCall: (observation) => observations.push(observation),
    });
    const meta = {
      [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
      [CLIENT_CAPABILITIES_META_KEY]: { tools: {} },
      [CLIENT_INFO_META_KEY]: { name: 'context-client', version: '1.0.0' },
    };
    await wrapped.handler.fetch(new Request('http://test.local/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'send_email',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'send_email',
          arguments: {
            user_query: 'Send the update',
            request_context: { workflow: 'release' },
          },
          _meta: meta,
        },
      }),
    }));

    expect(observations).toEqual([{
      toolName: 'send_email',
      arguments: {
        user_query: 'Send the update',
        request_context: { workflow: 'release' },
      },
      protocolVersion: '2026-07-28',
      clientCapabilities: { tools: {} },
      clientInfo: { name: 'context-client', version: '1.0.0' },
      userQuery: 'Send the update',
      requestContext: { workflow: 'release' },
    }]);
    expect(observations[0]).not.toHaveProperty('sessionId');
    wrapped.handle.destroy();
  });
});
