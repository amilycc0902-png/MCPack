import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  type CallToolRequest,
} from '@modelcontextprotocol/server';
import { ApprovalService } from '../../src/approval/approval-service.js';
import { InMemoryApprovalRepository } from '../../src/approval/repository.js';
import { createAuditService } from '../../src/audit/audit-service.js';
import { InMemoryAuditSink } from '../../src/audit/in-memory-audit-sink.js';
import { ToolCallService } from '../../src/gateway/tool-call-service.js';
import {
  CORRELATION_META_KEY,
  MCP_APPROVAL_EXECUTE_TOOL,
  MCP_APPROVAL_STATUS_TOOL,
  PolicyGatewayMCPAdapter,
} from '../../src/mcp/policy-gateway-adapter.js';
import { evaluatePolicy } from '../../src/policy/evaluator.js';
import { samplePolicies } from '../../src/policy/sample-policies.js';
import { defaultToolRegistry, type ToolExecutor } from '../../src/tools/registry.js';

const envelope = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [CLIENT_INFO_META_KEY]: { name: 'e2e-test-client', version: '1.0.0' },
};
const serverInfo = { name: 'mcpack-policy-gateway', version: '1.0.0' };

function call(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('MCP 2026 Policy Gateway end-to-end conformance', () => {
  it('proves allow, opaque deny, approval continuation, replay protection, and sanitized correlation', async () => {
    const sink = new InMemoryAuditSink();
    const audit = createAuditService(sink);
    const execute = vi.fn((name: string, args: Record<string, unknown>) =>
      defaultToolRegistry.execute(name, args));
    const executor: ToolExecutor = {
      validate: (name, args) => defaultToolRegistry.validate(name, args), execute,
    };
    const ids = ['approval-e2e-approved', 'approval-e2e-rejected'];
    const approvals = new ApprovalService({
      repository: new InMemoryApprovalRepository(), toolExecutor: executor,
      policies: samplePolicies, policyEvaluator: evaluatePolicy,
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      generateApprovalId: () => ids.shift() ?? 'approval-e2e-extra', audit,
    });
    const gateway = new ToolCallService({
      policies: samplePolicies, policyEvaluator: evaluatePolicy,
      toolExecutor: executor, approvalCreator: approvals,
      now: () => new Date('2026-08-24T12:00:00.000Z'), audit,
    });
    let gatewayId = 0;
    const adapter = new PolicyGatewayMCPAdapter({
      toolCallService: gateway, approvalService: approvals, serverInfo,
      generateGatewayRequestId: () => `gateway-e2e-${++gatewayId}`,
    });
    const support = { userId: 'support-1', userRole: 'support-agent', agentId: 'support-agent-1' };
    const billing = { userId: 'billing-1', userRole: 'billing-agent', agentId: 'billing-agent-1' };

    const allow = await adapter.handle({
      request: call('tickets.search', { query: 'payment' }), envelope,
      mcpRequestId: 'mcp-allow', identity: support,
    });
    const deny = await adapter.handle({
      request: call('refunds.execute', {
        customerId: 'c1', amount: 5, reason: 'duplicate', token: 'raw-token',
        secret: 'raw-secret', authorization: 'Bearer raw', email: 'private@example.test',
      }), envelope, mcpRequestId: 'mcp-deny', identity: support,
    });
    const pending = await adapter.handle({
      request: call('refunds.execute', { customerId: 'c1', amount: 5, reason: 'duplicate' }),
      envelope, mcpRequestId: 'mcp-origin', identity: billing,
    });
    const approvalId = String(payload(pending).approvalId);
    const status = await adapter.handle({
      request: call(MCP_APPROVAL_STATUS_TOOL, { approvalId }), envelope,
      mcpRequestId: 'mcp-status',
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(allow.resultType).toBe('complete');
    expect(allow._meta[SERVER_INFO_META_KEY]).toEqual(serverInfo);
    expect(deny.content[0].text).toBe('Unknown tool: refunds.execute');
    expect(JSON.stringify(deny)).not.toContain('support-refund-deny');
    expect(payload(pending)).toMatchObject({ decision: 'require_approval', executed: false });
    expect(payload(status)).toEqual({ approvalId, approvalStatus: 'pending', executed: false });

    await approvals.approve(approvalId, { reviewedBy: 'lead-1', reviewerRole: 'team-lead' });
    const execution = await adapter.handle({
      request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId }), envelope,
      mcpRequestId: 'mcp-execute',
      identity: { userId: 'attacker', userRole: 'admin', agentId: 'attacker' },
    });
    const replay = await adapter.handle({
      request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId }), envelope,
      mcpRequestId: 'mcp-retry-new-id',
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execution.resultType).toBe('complete');
    expect(execution._meta[SERVER_INFO_META_KEY]).toEqual(serverInfo);
    expect(execution._meta[CORRELATION_META_KEY]).toMatchObject({
      mcpRequestId: 'mcp-execute', originMcpRequestId: 'mcp-origin',
      gatewayRequestId: 'gateway-e2e-3', approvalId,
    });
    expect(replay.isError).toBe(true);
    expect(payload(replay)).toMatchObject({ approvalStatus: 'executed', executed: true });
    expect(execute).toHaveBeenCalledTimes(2);

    const deniedAudit = sink.getEvents().find((event) =>
      event.eventType === 'tool_call_received' && event.mcpRequestId === 'mcp-deny');
    expect(deniedAudit?.sanitizedArguments).toMatchObject({
      token: '[REDACTED]', secret: '[REDACTED]',
      authorization: '[REDACTED]', email: '[REDACTED]',
    });
    expect(JSON.stringify(sink.getEvents())).not.toContain('raw-token');
    const approvalEvents = sink.getEvents().filter((event) => event.approvalId === approvalId);
    expect(approvalEvents.every((event) =>
      event.requestId === 'gateway-e2e-3' && event.mcpRequestId === 'mcp-origin')).toBe(true);
    expect(approvalEvents.find((event) => event.eventType === 'approval_approved')?.reviewedBy).toBe('lead-1');
  });
});
