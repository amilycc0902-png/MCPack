import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { ToolCallService } from '../../src/gateway/tool-call-service.js';
import type { PolicyEvaluator } from '../../src/gateway/types.js';
import { evaluatePolicy } from '../../src/policy/evaluator.js';
import { samplePolicies } from '../../src/policy/sample-policies.js';
import type { ToolExecutor } from '../../src/tools/registry.js';
import { createAuditService } from '../../src/audit/audit-service.js';
import { InMemoryAuditSink } from '../../src/audit/in-memory-audit-sink.js';

const baseRequest = {
  requestId: 'req-001',
  userId: 'user-001',
  userRole: 'support-agent',
  agentId: 'support-agent-01',
  toolName: 'tickets.search',
  arguments: {
    query: 'payment failed',
  },
};

function createService(
  toolExecutor: ToolExecutor,
  policyEvaluator: PolicyEvaluator = evaluatePolicy,
): ToolCallService {
  return new ToolCallService({
    policies: samplePolicies,
    policyEvaluator,
    toolExecutor,
    approvalCreator: {
      createForDecision: async () => ({
        approvalId: 'approval-test',
      }),
    },
    now: () => new Date('2026-07-30T12:00:00.000Z'),
    audit: createAuditService(new InMemoryAuditSink()),
  });
}

describe('POST /v1/tools/call', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('executes an allowed tickets.search request', async () => {
    app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: baseRequest,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      requestId: 'req-001',
      decision: 'allow',
      matchedPolicyId: 'support-ticket-search',
      result: {
        tickets: [
          {
            ticketId: 'ticket-001',
            summary: 'Mock result for "payment failed"',
            status: 'open',
          },
        ],
        count: 1,
      },
    });
  });

  it('denies support-agent refunds.execute without executing it', async () => {
    const execute = vi.fn<ToolExecutor['execute']>();
    app = buildApp({
      toolCallService: createService({ execute }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: {
        ...baseRequest,
        toolName: 'refunds.execute',
        arguments: {
          customerId: 'customer-001',
          amount: 50,
          reason: 'Duplicate charge',
        },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      requestId: 'req-001',
      decision: 'deny',
      matchedPolicyId: 'support-refund-deny',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns require_approval for billing-agent refunds.execute without executing it', async () => {
    const execute = vi.fn<ToolExecutor['execute']>();
    app = buildApp({
      toolCallService: createService({ execute }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: {
        ...baseRequest,
        userRole: 'billing-agent',
        agentId: 'billing-agent-01',
        toolName: 'refunds.execute',
        arguments: {
          customerId: 'customer-001',
          amount: 50,
          reason: 'Duplicate charge',
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      requestId: 'req-001',
      decision: 'require_approval',
      matchedPolicyId: 'billing-refund-approval',
      approvalId: 'approval-test',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('denies an unknown tool without executing it', async () => {
    const execute = vi.fn<ToolExecutor['execute']>();
    app = buildApp({
      toolCallService: createService({ execute }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: {
        ...baseRequest,
        toolName: 'unknown.tool',
        arguments: {},
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      requestId: 'req-001',
      decision: 'deny',
      matchedPolicyId: 'unknown-tools-deny',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid request body', async () => {
    app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: {
        requestId: 'req-001',
        userId: 'user-001',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'Invalid request body.',
    });
  });

  it('returns 400 for invalid tool arguments', async () => {
    app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: {
        ...baseRequest,
        arguments: {
          query: 42,
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestId: 'req-001',
      error: 'Invalid tool arguments.',
    });
  });

  it('rejects invalid approval-required arguments before creating approval', async () => {
    app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: {
        ...baseRequest,
        userRole: 'billing-agent',
        agentId: 'billing-agent-01',
        toolName: 'refunds.execute',
        arguments: {
          customerId: 'customer-001',
          amount: 'not-a-number',
          reason: 'Duplicate charge',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestId: 'req-001',
      error: 'Invalid tool arguments.',
    });
  });

  it('handles a tool implementation error without exposing its message', async () => {
    const execute = vi
      .fn<ToolExecutor['execute']>()
      .mockRejectedValue(new Error('sensitive internal failure'));
    app = buildApp({
      toolCallService: createService({ execute }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: baseRequest,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      requestId: 'req-001',
      error: 'Mock tool execution failed.',
    });
    expect(response.body).not.toContain('sensitive internal failure');
  });

  it('evaluates policy before executing the tool', async () => {
    const events: string[] = [];
    const policyEvaluator: PolicyEvaluator = (requestContext) => {
      events.push('policy');
      expect(requestContext.timestamp).toBe('2026-07-30T12:00:00.000Z');
      return {
        decision: 'allow',
        matchedPolicyId: 'test-allow',
        reason: 'Allowed for ordering test.',
        requestId: requestContext.requestId,
      };
    };
    const toolExecutor: ToolExecutor = {
      execute: vi.fn(async () => {
        events.push('execute');
        return { ok: true };
      }),
    };
    app = buildApp({
      toolCallService: createService(toolExecutor, policyEvaluator),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: baseRequest,
    });

    expect(response.statusCode).toBe(200);
    expect(events).toEqual(['policy', 'execute']);
  });
});
