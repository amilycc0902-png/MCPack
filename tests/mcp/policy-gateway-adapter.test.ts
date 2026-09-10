/* eslint-disable @typescript-eslint/no-explicit-any -- MCP wire result assertions */
import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  type CallToolRequest,
} from '@modelcontextprotocol/server';
import { ToolCallService } from '../../src/gateway/tool-call-service.js';
import { evaluatePolicy } from '../../src/policy/evaluator.js';
import { samplePolicies } from '../../src/policy/sample-policies.js';
import {
  defaultToolRegistry,
  type ToolExecutor,
} from '../../src/tools/registry.js';
import { createAuditService } from '../../src/audit/audit-service.js';
import { InMemoryAuditSink } from '../../src/audit/in-memory-audit-sink.js';
import type { AuditSink } from '../../src/audit/types.js';
import {
  CORRELATION_META_KEY,
  PolicyGatewayMCPAdapter,
  type UntrustedPOCPolicyIdentity,
} from '../../src/mcp/policy-gateway-adapter.js';

const serverInfo = { name: 'policy-gateway-mcp', version: '1.0.0' };
const support: UntrustedPOCPolicyIdentity = {
  userId: 'support-1', userRole: 'support-agent', agentId: 'agent-support-1',
};
const billing: UntrustedPOCPolicyIdentity = {
  userId: 'billing-1', userRole: 'billing-agent', agentId: 'agent-billing-1',
};
const envelope = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
};

function call(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

function service(
  execute: ToolExecutor['execute'],
  approvalId = 'approval-m3-1',
  sink: AuditSink = new InMemoryAuditSink(),
) {
  const executor: ToolExecutor = {
    validate: (name, args) => defaultToolRegistry.validate(name, args),
    execute,
  };
  const createForDecision = vi.fn(async () => ({ approvalId }));
  return {
    toolCallService: new ToolCallService({
      policies: samplePolicies,
      policyEvaluator: evaluatePolicy,
      toolExecutor: executor,
      approvalCreator: { createForDecision },
      now: () => new Date('2026-08-23T12:00:00.000Z'),
      audit: createAuditService(sink),
    }),
    createForDecision,
  };
}

function adapter(toolCallService: ToolCallService) {
  return new PolicyGatewayMCPAdapter({
    toolCallService,
    serverInfo,
    generateGatewayRequestId: () => 'gateway-correlation-1',
  });
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('MCP-to-Policy-Gateway adapter', () => {
  it('maps an allow request and executes exactly once', async () => {
    const execute = vi.fn(async (name, args) =>
      defaultToolRegistry.execute(name, args));
    const fixture = service(execute);
    const result = await adapter(fixture.toolCallService).handle({
      request: call('tickets.search', { query: 'payment failed' }),
      envelope,
      mcpRequestId: 17,
      identity: support,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(payload(result)).toMatchObject({
      decision: 'allow', executed: true,
      result: { count: 1 },
    });
    expect(result.resultType).toBe('complete');
    expect(result._meta[SERVER_INFO_META_KEY]).toEqual(serverInfo);
  });

  it('maps deny opaquely and never executes', async () => {
    const execute = vi.fn<ToolExecutor['execute']>();
    const fixture = service(execute);
    const result = await adapter(fixture.toolCallService).handle({
      request: call('refunds.execute', {
        customerId: 'c1', amount: 5, reason: 'duplicate',
      }),
      envelope,
      mcpRequestId: 'mcp-deny-1',
      identity: support,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Unknown tool: refunds.execute');
    expect(JSON.stringify(result)).not.toContain('support-refund-deny');
  });

  it('returns an explicit approval handle without execution', async () => {
    const execute = vi.fn<ToolExecutor['execute']>();
    const fixture = service(execute, 'approval-m3-explicit');
    const result = await adapter(fixture.toolCallService).handle({
      request: call('refunds.execute', {
        customerId: 'c1', amount: 5, reason: 'duplicate',
      }),
      envelope,
      mcpRequestId: 'mcp-approval-1',
      identity: billing,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(fixture.createForDecision).toHaveBeenCalledOnce();
    expect(payload(result)).toEqual({
      decision: 'require_approval',
      approvalId: 'approval-m3-explicit',
      executed: false,
    });
    expect(result.resultType).toBe('complete');
  });

  it('fails closed when fixture identity is absent', async () => {
    const execute = vi.fn<ToolExecutor['execute']>();
    const fixture = service(execute);
    const handle = vi.spyOn(fixture.toolCallService, 'handle');
    const result = await adapter(fixture.toolCallService).handle({
      request: call('tickets.search', { query: 'payment' }),
      envelope,
      mcpRequestId: 2,
    });

    expect(handle).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Policy identity is required.');
  });

  it('does not derive authorization from clientInfo', async () => {
    const execute = vi.fn<ToolExecutor['execute']>();
    const fixture = service(execute);
    const result = await adapter(fixture.toolCallService).handle({
      request: call('refunds.execute', {
        customerId: 'c1', amount: 5, reason: 'duplicate',
      }),
      envelope: {
        ...envelope,
        [CLIENT_INFO_META_KEY]: { name: 'billing-agent', version: 'admin' },
      },
      mcpRequestId: 3,
      identity: support,
    });

    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.createForDecision).not.toHaveBeenCalled();
  });

  it('rejects unsupported metadata before gateway execution', async () => {
    const execute = vi.fn<ToolExecutor['execute']>();
    const fixture = service(execute);
    const handle = vi.spyOn(fixture.toolCallService, 'handle');

    await expect(adapter(fixture.toolCallService).handle({
      request: call('tickets.search', { query: 'payment' }),
      envelope: {
        ...envelope,
        [PROTOCOL_VERSION_META_KEY]: '2025-11-25',
      },
      mcpRequestId: 4,
      identity: support,
    })).rejects.toMatchObject({ code: -32022 });
    expect(handle).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('handles malformed MCP calls and invalid tool arguments safely', async () => {
    const execute = vi.fn<ToolExecutor['execute']>();
    const fixture = service(execute);
    const gatewayHandle = vi.spyOn(fixture.toolCallService, 'handle');
    const subject = adapter(fixture.toolCallService);
    const malformed = await subject.handle({
      request: { method: 'tools/call', params: { name: '', arguments: [] } } as any,
      envelope,
      mcpRequestId: 5,
      identity: support,
    });
    const invalidArguments = await subject.handle({
      request: call('tickets.search', { query: 42 }),
      envelope,
      mcpRequestId: 6,
      identity: support,
    });

    expect(malformed.isError).toBe(true);
    expect(gatewayHandle).toHaveBeenCalledOnce();
    expect(invalidArguments.isError).toBe(true);
    expect(invalidArguments.content[0].text).toBe('Invalid tool arguments.');
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps MCP, gateway, and approval identifiers distinct', async () => {
    const execute = vi.fn<ToolExecutor['execute']>();
    const fixture = service(execute, 'approval-distinct');
    const result = await adapter(fixture.toolCallService).handle({
      request: call('refunds.execute', {
        customerId: 'c1', amount: 5, reason: 'duplicate',
      }),
      envelope,
      mcpRequestId: 'mcp-request-distinct',
      identity: billing,
    });
    const correlation = result._meta[CORRELATION_META_KEY] as any;

    expect(correlation.mcpRequestId).toBe('mcp-request-distinct');
    expect(correlation.gatewayRequestId).toBe('gateway-correlation-1');
    expect(payload(result).approvalId).toBe('approval-distinct');
    expect(new Set([
      correlation.mcpRequestId,
      correlation.gatewayRequestId,
      payload(result).approvalId,
    ]).size).toBe(3);
  });

  it('preserves compatible gateway result metadata', async () => {
    const subject = new PolicyGatewayMCPAdapter({
      serverInfo,
      generateGatewayRequestId: () => 'gateway-meta-1',
      toolCallService: {
        handle: async () => ({
          statusCode: 200,
          body: {
            decision: 'allow',
            result: { ok: true },
            _meta: { upstreamTrace: 'trace-1' },
          },
        }),
      },
    });
    const result = await subject.handle({
      request: call('tickets.search', { query: 'payment' }),
      envelope,
      mcpRequestId: 8,
      identity: support,
    });

    expect(result._meta.upstreamTrace).toBe('trace-1');
    expect(result._meta[SERVER_INFO_META_KEY]).toEqual(serverInfo);
  });

  it('preserves audit failure fail-closed behavior', async () => {
    const execute = vi.fn<ToolExecutor['execute']>();
    const failingSink: AuditSink = { emit: async () => { throw new Error('down'); } };
    const fixture = service(execute, 'unused', failingSink);
    const result = await adapter(fixture.toolCallService).handle({
      request: call('tickets.search', { query: 'payment' }),
      envelope,
      mcpRequestId: 9,
      identity: support,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Tool call failed.');
    expect(execute).not.toHaveBeenCalled();
  });
});
