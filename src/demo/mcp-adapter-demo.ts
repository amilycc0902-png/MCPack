import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type CallToolRequest,
} from '@modelcontextprotocol/server';
import { ApprovalService } from '../approval/approval-service.js';
import { InMemoryApprovalRepository } from '../approval/repository.js';
import { InMemoryAuditSink } from '../audit/in-memory-audit-sink.js';
import { createAuditService } from '../audit/audit-service.js';
import { ToolCallService } from '../gateway/tool-call-service.js';
import {
  MCP_APPROVAL_EXECUTE_TOOL,
  MCP_APPROVAL_STATUS_TOOL,
  PolicyGatewayMCPAdapter,
} from '../mcp/policy-gateway-adapter.js';
import { evaluatePolicy } from '../policy/evaluator.js';
import { samplePolicies } from '../policy/sample-policies.js';
import { defaultToolRegistry, type ToolExecutor } from '../tools/registry.js';

let executions = 0;
const executor: ToolExecutor = {
  validate: (name, args) => defaultToolRegistry.validate(name, args),
  execute: async (name, args) => {
    executions += 1;
    return defaultToolRegistry.execute(name, args);
  },
};
const audit = createAuditService(new InMemoryAuditSink());
const approvalService = new ApprovalService({
  repository: new InMemoryApprovalRepository(),
  toolExecutor: executor,
  policies: samplePolicies,
  policyEvaluator: evaluatePolicy,
  now: () => new Date('2026-08-23T12:00:00.000Z'),
  generateApprovalId: () => 'approval-m4-demo',
  audit,
});
const toolCallService = new ToolCallService({
  policies: samplePolicies,
  policyEvaluator: evaluatePolicy,
  toolExecutor: executor,
  approvalCreator: approvalService,
  now: () => new Date('2026-08-23T12:00:00.000Z'),
  audit,
});
const adapter = new PolicyGatewayMCPAdapter({
  toolCallService,
  approvalService,
  serverInfo: { name: 'mcpack-policy-gateway', version: '1.0.0' },
  generateGatewayRequestId: (() => {
    let id = 0;
    return () => `gateway-demo-${++id}`;
  })(),
});
const envelope = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [CLIENT_INFO_META_KEY]: { name: 'm3-demo-client', version: '1.0.0' },
};

function call(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

const allow = await adapter.handle({
  request: call('tickets.search', { query: 'payment failed' }),
  envelope,
  mcpRequestId: 'mcp-demo-allow',
  identity: {
    userId: 'support-1', userRole: 'support-agent', agentId: 'support-agent-1',
  },
});
const afterAllow = executions;
const deny = await adapter.handle({
  request: call('refunds.execute', {
    customerId: 'customer-1', amount: 50, reason: 'duplicate',
  }),
  envelope,
  mcpRequestId: 'mcp-demo-deny',
  identity: {
    userId: 'support-1', userRole: 'support-agent', agentId: 'support-agent-1',
  },
});
const afterDeny = executions;
const approval = await adapter.handle({
  request: call('refunds.execute', {
    customerId: 'customer-1', amount: 50, reason: 'duplicate',
  }),
  envelope,
  mcpRequestId: 'mcp-demo-approval',
  identity: {
    userId: 'billing-1', userRole: 'billing-agent', agentId: 'billing-agent-1',
  },
});
const afterRequireApproval = executions;
const approvalId = JSON.parse(approval.content[0].text) as { approvalId: string };
const pendingStatus = await adapter.handle({
  request: call(MCP_APPROVAL_STATUS_TOOL, { approvalId: approvalId.approvalId }),
  envelope,
  mcpRequestId: 'mcp-demo-status',
});
await approvalService.approve(approvalId.approvalId, {
  reviewedBy: 'team-lead-1', reviewerRole: 'team-lead',
});
const approvedExecution = await adapter.handle({
  request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId: approvalId.approvalId }),
  envelope,
  mcpRequestId: 'mcp-demo-execute',
});
const afterApprovedExecution = executions;
const retryWithDifferentMcpId = await adapter.handle({
  request: call(MCP_APPROVAL_EXECUTE_TOOL, { approvalId: approvalId.approvalId }),
  envelope,
  mcpRequestId: 'mcp-demo-execute-retry',
});

console.log(JSON.stringify({
  allow,
  deny,
  requireApproval: approval,
  pendingStatus,
  approvedExecution,
  retryWithDifferentMcpId,
  executionCounts: {
    afterAllow,
    afterDeny,
    afterRequireApproval,
    afterApprovedExecution,
    afterRetry: executions,
  },
}, null, 2));
