import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const refundRequest = {
  requestId: 'req-refund-001',
  userId: 'user-billing-001',
  userRole: 'billing-agent',
  agentId: 'billing-agent-01',
  toolName: 'refunds.execute',
  arguments: {
    customerId: 'customer-001',
    amount: 50,
    reason: 'Duplicate charge',
  },
};

async function createPendingApproval(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/tools/call',
    payload: refundRequest,
  });

  expect(response.statusCode).toBe(202);
  const body = response.json<{ approvalId: string }>();
  expect(body.approvalId).toMatch(/^approval-/);
  return body.approvalId;
}

async function reviewApproval(
  app: FastifyInstance,
  approvalId: string,
  action: 'approve' | 'reject',
  reviewerRole = 'team-lead',
) {
  return app.inject({
    method: 'POST',
    url: `/v1/approvals/${approvalId}/${action}`,
    payload: {
      reviewedBy: 'lead-001',
      reviewerRole,
    },
  });
}

describe('human approval workflow', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('creates a pending approval for a billing-agent tool call', async () => {
    app = buildApp();

    const approvalId = await createPendingApproval(app);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/approvals/${approvalId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      approvalId,
      requestId: 'req-refund-001',
      status: 'pending',
      requesterUserId: 'user-billing-001',
      requesterRole: 'billing-agent',
      agentId: 'billing-agent-01',
      toolName: 'refunds.execute',
      matchedPolicyId: 'billing-refund-approval',
      reviewedBy: null,
      reviewedAt: null,
    });
  });

  it('supports explicit approval creation through POST /v1/approvals', async () => {
    app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/approvals',
      payload: refundRequest,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      requestId: 'req-refund-001',
      status: 'pending',
      matchedPolicyId: 'billing-refund-approval',
    });
  });

  it('allows a team lead to approve a pending request', async () => {
    app = buildApp();
    const approvalId = await createPendingApproval(app);

    const response = await reviewApproval(app, approvalId, 'approve');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      approvalId,
      status: 'approved',
      reviewedBy: 'lead-001',
    });
    expect(response.json<{ reviewedAt: string }>().reviewedAt).toBeTruthy();
  });

  it('executes an approved refund and marks it executed', async () => {
    app = buildApp();
    const approvalId = await createPendingApproval(app);
    await reviewApproval(app, approvalId, 'approve');

    const response = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/execute`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      approvalId,
      requestId: 'req-refund-001',
      status: 'executed',
      result: {
        status: 'simulated',
        amount: 50,
      },
    });
  });

  it('does not execute a rejected request', async () => {
    app = buildApp();
    const approvalId = await createPendingApproval(app);
    const rejectResponse = await reviewApproval(app, approvalId, 'reject');

    expect(rejectResponse.statusCode).toBe(200);
    expect(rejectResponse.json()).toMatchObject({
      approvalId,
      status: 'rejected',
    });

    const executeResponse = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/execute`,
    });

    expect(executeResponse.statusCode).toBe(409);
    expect(executeResponse.json()).toMatchObject({
      approvalId,
      status: 'rejected',
    });
  });

  it('prevents a non-team-lead from approving', async () => {
    app = buildApp();
    const approvalId = await createPendingApproval(app);

    const response = await reviewApproval(
      app,
      approvalId,
      'approve',
      'billing-agent',
    );

    expect(response.statusCode).toBe(403);

    const statusResponse = await app.inject({
      method: 'GET',
      url: `/v1/approvals/${approvalId}`,
    });
    expect(statusResponse.json()).toMatchObject({ status: 'pending' });
  });

  it('prevents duplicate execution', async () => {
    app = buildApp();
    const approvalId = await createPendingApproval(app);
    await reviewApproval(app, approvalId, 'approve');

    const firstResponse = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/execute`,
    });
    const secondResponse = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/execute`,
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(409);
    expect(secondResponse.json()).toMatchObject({
      approvalId,
      status: 'executed',
    });
  });

  it('prevents concurrent duplicate execution attempts', async () => {
    app = buildApp();
    const approvalId = await createPendingApproval(app);
    await reviewApproval(app, approvalId, 'approve');

    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/execute`,
      }),
      app.inject({
        method: 'POST',
        url: `/v1/approvals/${approvalId}/execute`,
      }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
  });

  it('returns 404 for a missing approval', async () => {
    app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/approvals/approval-missing/execute',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      approvalId: 'approval-missing',
      error: 'Approval not found.',
    });
  });
});
