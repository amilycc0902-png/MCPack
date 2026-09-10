import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  type CallToolRequest,
} from '@modelcontextprotocol/server';
import { ApprovalService } from '../approval/approval-service.js';
import { InMemoryApprovalRepository } from '../approval/repository.js';
import { createAuditService } from '../audit/audit-service.js';
import { InMemoryAuditSink } from '../audit/in-memory-audit-sink.js';
import { createMCPackServer } from '../build.js';
import { ToolCallService } from '../gateway/tool-call-service.js';
import {
  CORRELATION_META_KEY,
  MCP_APPROVAL_EXECUTE_TOOL,
  MCP_APPROVAL_STATUS_TOOL,
  PolicyGatewayMCPAdapter,
} from '../mcp/policy-gateway-adapter.js';
import { evaluatePolicy } from '../policy/evaluator.js';
import { samplePolicies } from '../policy/sample-policies.js';
import { defaultToolRegistry, type ToolExecutor } from '../tools/registry.js';

const serverInfo = { name: 'mcpack-policy-gateway', version: '1.0.0' };
const envelope = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [CLIENT_INFO_META_KEY]: { name: 'mcpack-e2e-demo', version: '1.0.0' },
};

function call(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

function body(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

async function discoverFirst() {
  const built = createMCPackServer({
    name: serverInfo.name,
    version: serverInfo.version,
    tools: [{
      name: 'demo.health',
      description: 'Local demonstration health tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ ok: true }),
    }],
  });
  const request = new Request('http://demo.local/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'server/discover',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'discover-first', method: 'server/discover',
      params: { _meta: envelope },
    }),
  });
  const response = await built.handler.fetch(request);
  const payload = await response.json() as {
    result: Record<string, unknown> & { _meta: Record<string, unknown> };
  };
  built.handle.destroy();
  return payload.result;
}

let executions = 0;
const sink = new InMemoryAuditSink();
const audit = createAuditService(sink);
const executor: ToolExecutor = {
  validate: (name, args) => defaultToolRegistry.validate(name, args),
  execute: async (name, args) => {
    executions += 1;
    return defaultToolRegistry.execute(name, args);
  },
};
const approvalIds = ['approval-e2e-approved', 'approval-e2e-rejected'];
const approvalService = new ApprovalService({
  repository: new InMemoryApprovalRepository(), toolExecutor: executor,
  policies: samplePolicies, policyEvaluator: evaluatePolicy,
  now: () => new Date('2026-08-24T12:00:00.000Z'),
  generateApprovalId: () => approvalIds.shift() ?? 'approval-e2e-unexpected', audit,
});
const toolCallService = new ToolCallService({
  policies: samplePolicies, policyEvaluator: evaluatePolicy, toolExecutor: executor,
  approvalCreator: approvalService,
  now: () => new Date('2026-08-24T12:00:00.000Z'), audit,
});
const adapter = new PolicyGatewayMCPAdapter({
  toolCallService, approvalService, serverInfo,
  generateGatewayRequestId: (() => {
    let value = 0;
    return () => `gateway-e2e-${++value}`;
  })(),
});
const support = { userId: 'support-1', userRole: 'support-agent', agentId: 'support-agent-1' };
const billing = { userId: 'billing-1', userRole: 'billing-agent', agentId: 'billing-agent-1' };

const discovery = await discoverFirst();
const allowed = await adapter.handle({
  request: call('tickets.search', { query: 'payment failed' }), envelope,
  mcpRequestId: 'mcp-e2e-allow', identity: support,
});
const afterAllow = executions;
const denied = await adapter.handle({
  request: call('refunds.execute', {
    customerId: 'customer-1', amount: 50, reason: 'duplicate',
    token: 'token-value', secret: 'secret-value',
    authorization: 'Bearer credential', email: 'private@example.test',
  }), envelope, mcpRequestId: 'mcp-e2e-deny', identity: support,
});
const afterDeny = executions;
const pending = await adapter.handle({
  request: call('refunds.execute', { customerId: 'customer-1', amount: 50, reason: 'duplicate' }),
  envelope, mcpRequestId: 'mcp-e2e-approval-origin', identity: billing,
});
const pendingBody = body(pending);
const approvalId = String(pendingBody.approvalId);
const afterRequireApproval = executions;
const pendingStatus = await adapter.handle({
  request: call(MCP_APPROVAL_STATUS_TOOL, { approvalId }), envelope,
  mcpRequestId: 'mcp-e2e-status',
});
await approvalService.approve(approvalId, { reviewedBy: 'team-lead-1', reviewerRole: 'team-lead' });
const approvedRecord = approvalService.get(approvalId).body;
const executed = await adapter.handle({
  request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId }), envelope,
  mcpRequestId: 'mcp-e2e-execute',
});
const afterExecution = executions;
const replay = await adapter.handle({
  request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId }), envelope,
  mcpRequestId: 'mcp-e2e-replay-new-id',
});
const afterReplay = executions;
const rejectedPending = await adapter.handle({
  request: call('refunds.execute', { customerId: 'customer-2', amount: 25, reason: 'requested' }),
  envelope, mcpRequestId: 'mcp-e2e-rejected-origin', identity: billing,
});
const rejectedApprovalId = String(body(rejectedPending).approvalId);
await approvalService.reject(rejectedApprovalId, { reviewedBy: 'team-lead-1', reviewerRole: 'team-lead' });
const rejectedExecution = await adapter.handle({
  request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId: rejectedApprovalId }), envelope,
  mcpRequestId: 'mcp-e2e-rejected-execute',
});

const auditSummary = sink.getEvents()
  .filter((event) => event.eventType === 'tool_call_received' || event.approvalId !== undefined)
  .map((event) => ({
    eventType: event.eventType, requestId: event.requestId,
    mcpRequestId: event.mcpRequestId, requester: event.userId,
    actingAgent: event.agentId, tool: event.toolName, decision: event.decision,
    approvalId: event.approvalId, approvalStatus: event.approvalStatus,
    reviewer: event.reviewedBy, arguments: event.sanitizedArguments,
    result: event.resultSummary,
  }));

console.log(JSON.stringify({
  scenario1Discovery: {
    supportedVersions: discovery.supportedVersions,
    capabilities: discovery.capabilities,
    serverInfo: discovery._meta[SERVER_INFO_META_KEY],
    resultType: discovery.resultType,
    firstRequest: true, initializeUsed: false, sessionIdUsed: false,
  },
  scenario2Allow: { result: body(allowed), executions: afterAllow, resultType: allowed.resultType,
    serverInfo: allowed._meta[SERVER_INFO_META_KEY], correlation: allowed._meta[CORRELATION_META_KEY] },
  scenario3Deny: { opaqueError: denied.content[0].text, executions: afterDeny,
    leakedPolicyDetails: JSON.stringify(denied).includes('support-refund-deny') },
  scenario4RequireApproval: { ...pendingBody, executions: afterRequireApproval },
  scenario5PendingStatus: body(pendingStatus),
  scenario6HumanApproval: {
    approvalStatus: approvedRecord.status, requesterUserId: approvedRecord.requesterUserId,
    requesterRole: approvedRecord.requesterRole, agentId: approvedRecord.agentId,
    toolName: approvedRecord.toolName, arguments: approvedRecord.arguments,
  },
  scenario7StatelessExecution: { result: body(executed), resultType: executed.resultType,
    serverInfo: executed._meta[SERVER_INFO_META_KEY], correlation: executed._meta[CORRELATION_META_KEY],
    executions: afterExecution },
  scenario8ReplayProtection: { result: body(replay), differentMcpRequestId: true,
    executionsBefore: afterExecution, executionsAfter: afterReplay },
  scenario9RejectedApproval: { approvalId: rejectedApprovalId, result: body(rejectedExecution),
    executionsBefore: afterReplay, executionsAfter: executions },
  scenario10SanitizedAudit: auditSummary,
  finalExecutionCount: executions,
}, null, 2));
