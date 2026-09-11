import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export const tool = () => ({
  name: 'search_issues',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1 } },
    required: ['query'],
    additionalProperties: false,
  },
});
export const searchResult = () => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        total_count: 1,
        items: [
          {
            id: 12,
            title: 'An issue',
            state: 'open',
            email: 'secret@example.test',
            body: 'raw-secret',
          },
        ],
      }),
    },
  ],
});

export class FakeUpstream implements Transport {
  onmessage?: Transport['onmessage'];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  messages: JSONRPCMessage[] = [];
  closed = false;
  protocol = '2025-11-25';
  capabilities = { tools: {} } as Record<string, unknown>;
  catalog: unknown = { tools: [tool()] };
  result: unknown = searchResult();
  failMethod = '';
  hangMethod = '';
  rpcError = false;
  async start() {
    if (this.failMethod === 'start')
      throw new Error('Bearer credential-secret');
  }
  async close() {
    this.closed = true;
    this.onclose?.();
  }
  async send(message: JSONRPCMessage) {
    this.messages.push(structuredClone(message));
    if (!('method' in message) || !('id' in message)) return;
    if (message.method === this.failMethod)
      throw new Error('Bearer credential-secret');
    if (message.method === this.hangMethod) return;
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: this.protocol,
            capabilities: this.capabilities,
            serverInfo: { name: 'fake-github', version: '1' },
          }
        : message.method === 'tools/list'
          ? this.catalog
          : this.result;
    const response =
      this.rpcError && message.method === 'tools/call'
        ? {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: 'Bearer credential-secret' },
          }
        : { jsonrpc: '2.0', id: message.id, result };
    queueMicrotask(() => {
      if (!this.closed) this.onmessage?.(response as JSONRPCMessage);
    });
  }
  calls() {
    return this.messages.filter(
      (m) => 'method' in m && m.method === 'tools/call',
    );
  }
}
