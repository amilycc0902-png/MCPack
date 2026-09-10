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

const serverInfo = { name: 'mcpack-policy-gateway', version: '1.0.0' };
const envelope = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [CLIENT_INFO_META_KEY]: { name: 'm4-client', version: '1.0.0' },
};

function call(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function fixture(executeImpl?: ToolExecutor['execute']) {
  const sink = new InMemoryAuditSink();
  const audit = createAuditService(sink);
  const execute = vi.fn(executeImpl ?? ((name, args) => defaultToolRegistry.execute(name, args)));
  const executor: ToolExecutor = {
    validate: (name, args) => defaultToolRegistry.validate(name, args),
    execute,
  };
  const approvalService = new ApprovalService({
    repository: new InMemoryApprovalRepository(),
    toolExecutor: executor, policies: samplePolicies, policyEvaluator: evaluatePolicy,
    now: () => new Date('2026-08-24T12:00:00.000Z'),
    generateApprovalId: () => 'approval-m4-explicit', audit,
  });
  const toolCallService = new ToolCallService({
    policies: samplePolicies, policyEvaluator: evaluatePolicy, toolExecutor: executor,
    approvalCreator: approvalService, now: () => new Date('2026-08-24T12:00:00.000Z'), audit,
  });
  const adapter = new PolicyGatewayMCPAdapter({
    toolCallService, approvalService, serverInfo,
    generateGatewayRequestId: () => 'gateway-m4-original',
  });
  return { adapter, approvalService, execute, sink };
}

async function createPending(subject: ReturnType<typeof fixture>) {
  return subject.adapter.handle({
    request: call('refunds.execute', { customerId: 'customer-1', amount: 50, reason: 'duplicate' }),
    envelope, mcpRequestId: 'mcp-m4-original',
    identity: { userId: 'billing-1', userRole: 'billing-agent', agentId: 'billing-agent-1' },
  });
}

describe('M4 explicit approval continuation', () => {
  it('returns pending status and does not execute', async () => {
    const subject = fixture();
    await createPending(subject);
    const result = await subject.adapter.handle({ request: call(MCP_APPROVAL_STATUS_TOOL, {
      approvalId: 'approval-m4-explicit',
    }), envelope, mcpRequestId: 'mcp-status' });
    expect(payload(result)).toEqual({ approvalId: 'approval-m4-explicit', approvalStatus: 'pending', executed: false });
    expect(subject.execute).not.toHaveBeenCalled();
    expect(result.resultType).toBe('complete');
    expect(result._meta[SERVER_INFO_META_KEY]).toEqual(serverInfo);
  });

  it('executes an approved handle once and returns the sanitized tool result', async () => {
    const subject = fixture();
    await createPending(subject);
    await subject.approvalService.approve('approval-m4-explicit', { reviewedBy: 'lead-1', reviewerRole: 'team-lead' });
    const result = await subject.adapter.handle({ request: call(MCP_APPROVAL_EXECUTE_TOOL, {
      approvalId: 'approval-m4-explicit',
    }), envelope, mcpRequestId: 'mcp-execute' });
    expect(payload(result)).toMatchObject({ approvalId: 'approval-m4-explicit', approvalStatus: 'executed', executed: true });
    expect(payload(result).result).toMatchObject({ status: 'simulated', amount: 50 });
    expect(subject.execute).toHaveBeenCalledOnce();
  });

  it('rejects pending, rejected, malformed, unknown, and tampered handles safely', async () => {
    const subject = fixture();
    await createPending(subject);
    const pending = await subject.adapter.handle({ request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId: 'approval-m4-explicit' }), envelope, mcpRequestId: 1 });
    await subject.approvalService.reject('approval-m4-explicit', { reviewedBy: 'lead-1', reviewerRole: 'team-lead' });
    const rejected = await subject.adapter.handle({ request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId: 'approval-m4-explicit' }), envelope, mcpRequestId: 2 });
    const malformed = await subject.adapter.handle({ request: call(MCP_APPROVAL_STATUS_TOOL, { approvalId: '../secret' }), envelope, mcpRequestId: 3 });
    const unknown = await subject.adapter.handle({ request: call(MCP_APPROVAL_STATUS_TOOL, { approvalId: 'approval-unknown' }), envelope, mcpRequestId: 4 });
    const tampered = await subject.adapter.handle({ request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId: 'approval-m4-explicit', amount: 999 }), envelope, mcpRequestId: 5 });
    expect([pending, rejected, malformed, unknown, tampered].every((value) => value.isError)).toBe(true);
    expect(JSON.stringify([malformed, unknown])).not.toContain('../secret');
    expect(subject.execute).not.toHaveBeenCalled();
  });

  it('does not let continuation identity or clientInfo replace the original request', async () => {
    const subject = fixture();
    await createPending(subject);
    await subject.approvalService.approve('approval-m4-explicit', { reviewedBy: 'lead-1', reviewerRole: 'team-lead' });
    await subject.adapter.handle({
      request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId: 'approval-m4-explicit' }),
      envelope: { ...envelope, [CLIENT_INFO_META_KEY]: { name: 'admin', version: 'root' } },
      mcpRequestId: 'mcp-malicious',
      identity: { userId: 'attacker', userRole: 'admin', agentId: 'attacker-agent' },
    });
    expect(subject.execute).toHaveBeenCalledWith('refunds.execute', {
      customerId: 'customer-1', amount: 50, reason: 'duplicate',
    });
    const started = subject.sink.getEvents().find((event) => event.eventType === 'tool_execution_started');
    expect(started).toMatchObject({ userId: 'billing-1', userRole: 'billing-agent', agentId: 'billing-agent-1' });
  });

  it('is exactly-once across concurrent calls and retries with different MCP IDs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const subject = fixture(async (name, args) => { await gate; return defaultToolRegistry.execute(name, args); });
    await createPending(subject);
    await subject.approvalService.approve('approval-m4-explicit', { reviewedBy: 'lead-1', reviewerRole: 'team-lead' });
    const first = subject.adapter.handle({ request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId: 'approval-m4-explicit' }), envelope, mcpRequestId: 'mcp-a' });
    const second = subject.adapter.handle({ request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId: 'approval-m4-explicit' }), envelope, mcpRequestId: 'mcp-b' });
    release();
    const concurrent = await Promise.all([first, second]);
    const retry = await subject.adapter.handle({ request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId: 'approval-m4-explicit' }), envelope, mcpRequestId: 'mcp-c' });
    expect(subject.execute).toHaveBeenCalledOnce();
    expect(concurrent.filter((result) => !result.isError)).toHaveLength(1);
    expect(retry.isError).toBe(true);
    expect(payload(retry)).toMatchObject({ approvalStatus: 'executed', executed: true });
  });

  it('correlates original MCP, gateway, approval, review, and execution events', async () => {
    const subject = fixture();
    await createPending(subject);
    await subject.approvalService.approve('approval-m4-explicit', { reviewedBy: 'lead-1', reviewerRole: 'team-lead' });
    const result = await subject.adapter.handle({ request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId: 'approval-m4-explicit' }), envelope, mcpRequestId: 'mcp-continuation' });
    expect(result._meta[CORRELATION_META_KEY]).toMatchObject({
      mcpRequestId: 'mcp-continuation', originMcpRequestId: 'mcp-m4-original',
      gatewayRequestId: 'gateway-m4-original', approvalId: 'approval-m4-explicit',
    });
    const related = subject.sink.getEvents().filter((event) => event.approvalId === 'approval-m4-explicit');
    expect(related.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      'approval_created', 'approval_approved', 'tool_execution_started', 'tool_execution_succeeded',
    ]));
    expect(related.every((event) => event.requestId === 'gateway-m4-original' && event.mcpRequestId === 'mcp-m4-original')).toBe(true);
    expect(related.find((event) => event.eventType === 'approval_approved')?.reviewedBy).toBe('lead-1');
  });
});
