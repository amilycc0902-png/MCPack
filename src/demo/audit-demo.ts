import { buildApp } from '../app.js';
import { InMemoryAuditSink } from '../audit/in-memory-audit-sink.js';

const auditSink = new InMemoryAuditSink();
const app = buildApp({ auditSink });

async function post(path: string, payload?: unknown) {
  const response =
    payload === undefined
      ? await app.inject({ method: 'POST', url: path })
      : await app.inject({
          method: 'POST',
          url: path,
          payload: payload as Record<string, unknown>,
        });
  const body = response.json<Record<string, unknown>>();
  console.log(`\nPOST ${path} -> ${response.statusCode}`);
  console.log(JSON.stringify(body, null, 2));
  return body;
}

try {
  await post('/v1/tools/call', {
    requestId: 'demo-allow',
    userId: 'user-support',
    userRole: 'support-agent',
    agentId: 'support-agent-01',
    toolName: 'tickets.search',
    arguments: { query: 'payment failed' },
  });

  await post('/v1/tools/call', {
    requestId: 'demo-deny',
    userId: 'user-support',
    userRole: 'support-agent',
    agentId: 'support-agent-01',
    toolName: 'refunds.execute',
    arguments: {
      customerId: 'customer-001',
      amount: 25,
      reason: 'Duplicate charge',
      token: 'demo-secret-token',
    },
  });

  const pending = await post('/v1/tools/call', {
    requestId: 'demo-approval',
    userId: 'user-billing',
    userRole: 'billing-agent',
    agentId: 'billing-agent-01',
    toolName: 'refunds.execute',
    arguments: {
      customerId: 'customer-002',
      amount: 42,
      reason: 'Billing correction',
    },
  });
  const approvalId = String(pending.approvalId);

  await post(`/v1/approvals/${approvalId}/approve`, {
    reviewedBy: 'team-lead-001',
    reviewerRole: 'team-lead',
  });
  await post(`/v1/approvals/${approvalId}/execute`);

  console.log('\nGenerated sanitized audit events');
  console.log(JSON.stringify(auditSink.getEvents(), null, 2));
} finally {
  await app.close();
}
