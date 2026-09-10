import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { InMemoryAuditSink } from '../../src/audit/in-memory-audit-sink.js';
import type { AuditSink } from '../../src/audit/types.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolCallService } from '../../src/gateway/tool-call-service.js';
import { createAuditService } from '../../src/audit/audit-service.js';
import { evaluatePolicy } from '../../src/policy/evaluator.js';
import { samplePolicies } from '../../src/policy/sample-policies.js';

const support = {
  userId: 'user-1',
  userRole: 'support-agent',
  agentId: 'support-agent-1',
};

describe('audit integration', () => {
  it('emits the allow lifecycle', async () => {
    const sink = new InMemoryAuditSink();
    const app = buildApp({ auditSink: sink });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: {
        requestId: 'allow-1',
        ...support,
        toolName: 'tickets.search',
        arguments: { query: 'payment' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(sink.getEvents().map((event) => event.eventType)).toEqual([
      'tool_call_received',
      'policy_decided',
      'tool_execution_started',
      'tool_execution_succeeded',
    ]);
    await app.close();
  });

  it('emits the deny lifecycle without execution', async () => {
    const sink = new InMemoryAuditSink();
    const app = buildApp({ auditSink: sink });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: {
        requestId: 'deny-1',
        ...support,
        toolName: 'refunds.execute',
        arguments: { customerId: 'c1', amount: 5, reason: 'duplicate' },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(sink.getEvents().map((event) => event.eventType)).toEqual([
      'tool_call_received',
      'policy_decided',
      'tool_call_denied',
    ]);
    await app.close();
  });

  it('emits approval creation, approval, and execution', async () => {
    const sink = new InMemoryAuditSink();
    const app = buildApp({ auditSink: sink });
    const pending = await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: {
        requestId: 'approval-1',
        userId: 'billing-1',
        userRole: 'billing-agent',
        agentId: 'billing-agent-1',
        toolName: 'refunds.execute',
        arguments: { customerId: 'c1', amount: 5, reason: 'duplicate' },
      },
    });
    const approvalId = pending.json<{ approvalId: string }>().approvalId;

    await app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/approve`,
      payload: { reviewedBy: 'lead-1', reviewerRole: 'team-lead' },
    });
    const executed = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/execute`,
    });

    expect(executed.statusCode).toBe(200);
    expect(sink.getEvents().map((event) => event.eventType)).toEqual([
      'tool_call_received',
      'policy_decided',
      'approval_created',
      'approval_approved',
      'tool_execution_started',
      'tool_execution_succeeded',
    ]);
    await app.close();
  });

  it('emits rejected approvals and never starts execution', async () => {
    const sink = new InMemoryAuditSink();
    const app = buildApp({ auditSink: sink });
    const pending = await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: {
        requestId: 'reject-1',
        userId: 'billing-1',
        userRole: 'billing-agent',
        agentId: 'billing-agent-1',
        toolName: 'refunds.execute',
        arguments: { customerId: 'c1', amount: 5, reason: 'duplicate' },
      },
    });
    const approvalId = pending.json<{ approvalId: string }>().approvalId;
    const rejected = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/reject`,
      payload: { reviewedBy: 'lead-1', reviewerRole: 'team-lead' },
    });

    expect(rejected.statusCode).toBe(200);
    expect(sink.getEvents().at(-1)?.eventType).toBe('approval_rejected');
    expect(
      sink.getEvents().some((event) => event.eventType.includes('execution')),
    ).toBe(false);
    await app.close();
  });

  it('recursively redacts sensitive argument and result fields', async () => {
    const sink = new InMemoryAuditSink();
    await sink.emit({
      eventId: 'event-1',
      eventType: 'tool_call_received',
      requestId: 'sanitize-1',
      timestamp: new Date(0).toISOString(),
      sanitizedArguments: {
        password: '[REDACTED]',
        nested: { email: '[REDACTED]' },
      },
    });
    const app = buildApp({ auditSink: sink });
    await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: {
        requestId: 'sanitize-2',
        ...support,
        toolName: 'tickets.search',
        arguments: {
          query: 'payment',
          password: 'never-log-me',
          customerEmail: 'never-log-me@example.test',
          nested: { accessToken: 'Bearer never-log-me' },
        },
      },
    });

    const serialized = JSON.stringify(sink.getEvents());
    expect(serialized).not.toContain('never-log-me');
    expect(serialized).toContain('[REDACTED]');
    await app.close();
  });

  it('fails closed before execution when required audit delivery fails', async () => {
    let executions = 0;
    const failingSink: AuditSink = {
      emit: async () => {
        throw new Error('sink unavailable');
      },
    };
    const toolExecutor = new ToolRegistry([
      {
        name: 'tickets.search',
        validate: () => undefined,
        execute: async () => {
          executions += 1;
          return {};
        },
      },
    ]);
    const service = new ToolCallService({
      policies: samplePolicies,
      policyEvaluator: evaluatePolicy,
      toolExecutor,
      approvalCreator: {
        createForDecision: async () => ({ approvalId: 'unused' }),
      },
      now: () => new Date(0),
      audit: createAuditService(failingSink),
    });

    const response = await service.handle({
      requestId: 'audit-failure',
      ...support,
      toolName: 'tickets.search',
      arguments: { query: 'payment' },
    });

    expect(response.statusCode).toBe(500);
    expect(executions).toBe(0);
  });

  it('does not copy internal execution errors into audit events', async () => {
    const sink = new InMemoryAuditSink();
    const service = new ToolCallService({
      policies: samplePolicies,
      policyEvaluator: evaluatePolicy,
      toolExecutor: {
        execute: async () => {
          throw new Error('internal-secret-value');
        },
      },
      approvalCreator: {
        createForDecision: async () => ({ approvalId: 'unused' }),
      },
      now: () => new Date(0),
      audit: createAuditService(sink),
    });

    await service.handle({
      requestId: 'execution-failure',
      ...support,
      toolName: 'tickets.search',
      arguments: { query: 'payment' },
    });

    expect(JSON.stringify(sink.getEvents())).not.toContain(
      'internal-secret-value',
    );
    expect(sink.getEvents().at(-1)).toMatchObject({
      eventType: 'tool_execution_failed',
      reason: 'Mock tool execution failed.',
    });
  });
});
