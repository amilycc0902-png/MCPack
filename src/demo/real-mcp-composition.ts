import { createDefaultApprovalService } from '../approval/approval-service.js';
import { createAuditService } from '../audit/audit-service.js';
import { InMemoryAuditSink } from '../audit/in-memory-audit-sink.js';
import { ToolCallService } from '../gateway/tool-call-service.js';
import { PolicyGatewayMCPAdapter } from '../mcp/policy-gateway-adapter.js';
import { evaluatePolicy } from '../policy/evaluator.js';
import { samplePolicies } from '../policy/sample-policies.js';
import type { ToolExecutor } from '../tools/registry.js';
import { RoutingToolExecutor } from '../tools/routing-tool-executor.js';

export function createRealMCPPilot(upstream: ToolExecutor) {
  const sink = new InMemoryAuditSink();
  const audit = createAuditService(sink);
  const executor = new RoutingToolExecutor(upstream);
  const approvalService = createDefaultApprovalService(
    executor,
    samplePolicies,
    evaluatePolicy,
    audit,
  );
  const toolCallService = new ToolCallService({
    policies: samplePolicies,
    policyEvaluator: evaluatePolicy,
    toolExecutor: executor,
    approvalCreator: approvalService,
    audit,
    now: () => new Date(),
  });
  const adapter = new PolicyGatewayMCPAdapter({
    toolCallService,
    approvalService,
    serverInfo: { name: 'mcpack-real-pilot', version: '1.0.0' },
  });
  return { adapter, approvalService, toolCallService, sink };
}
