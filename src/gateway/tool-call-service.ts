import { evaluatePolicy } from '../policy/evaluator.js';
import { samplePolicies } from '../policy/sample-policies.js';
import type {
  Policy,
  PolicyDecision,
  RequestContext,
} from '../policy/types.js';
import {
  defaultToolRegistry,
  ToolArgumentValidationError,
  type ToolExecutor,
  UnknownToolError,
} from '../tools/registry.js';
import type {
  ApprovalCreator,
  PolicyEvaluator,
  ToolCallRequest,
  ToolCallServiceResponse,
} from './types.js';
import { AuditService } from '../audit/audit-service.js';
import { sanitizeAuditData, sanitizeAuditResult } from '../audit/sanitize.js';

export interface ToolCallServiceOptions {
  policies: readonly Policy[];
  policyEvaluator: PolicyEvaluator;
  toolExecutor: ToolExecutor;
  approvalCreator: ApprovalCreator;
  now: () => Date;
  audit: AuditService;
}

function decisionBody(decision: PolicyDecision): Record<string, unknown> {
  return {
    requestId: decision.requestId,
    decision: decision.decision,
    matchedPolicyId: decision.matchedPolicyId,
    reason: decision.reason,
  };
}

export class ToolCallService {
  private readonly options: ToolCallServiceOptions;

  constructor(options: ToolCallServiceOptions) {
    this.options = options;
  }

  async handle(request: ToolCallRequest): Promise<ToolCallServiceResponse> {
    const requestContext: RequestContext = {
      ...request,
      timestamp: this.options.now().toISOString(),
    };
    try {
      await this.options.audit.emit({
        eventType: 'tool_call_received',
        requestId: requestContext.requestId,
        mcpRequestId: requestContext.mcpRequestId,
        userId: requestContext.userId,
        userRole: requestContext.userRole,
        agentId: requestContext.agentId,
        toolName: requestContext.toolName,
        sanitizedArguments: sanitizeAuditData(requestContext.arguments),
      });
      const decision = this.options.policyEvaluator(
        requestContext,
        this.options.policies,
      );
      await this.options.audit.emit({
        eventType: 'policy_decided',
        requestId: requestContext.requestId,
        mcpRequestId: requestContext.mcpRequestId,
        userId: requestContext.userId,
        userRole: requestContext.userRole,
        agentId: requestContext.agentId,
        toolName: requestContext.toolName,
        decision: decision.decision,
        matchedPolicyId: decision.matchedPolicyId,
        reason: decision.reason,
      });

      if (decision.decision === 'deny') {
        await this.options.audit.emit({
          eventType: 'tool_call_denied',
          requestId: requestContext.requestId,
          mcpRequestId: requestContext.mcpRequestId,
          userId: requestContext.userId,
          userRole: requestContext.userRole,
          agentId: requestContext.agentId,
          toolName: requestContext.toolName,
          decision: decision.decision,
          matchedPolicyId: decision.matchedPolicyId,
          reason: decision.reason,
        });
        return {
          statusCode: 403,
          body: decisionBody(decision),
        };
      }

      if (decision.decision === 'require_approval') {
        this.options.toolExecutor.validate?.(
          requestContext.toolName,
          requestContext.arguments,
        );
        const approval = await this.options.approvalCreator.createForDecision(
          requestContext,
          decision,
        );
        return {
          statusCode: 202,
          body: {
            ...decisionBody(decision),
            approvalId: approval.approvalId,
          },
        };
      }

      this.options.toolExecutor.validate?.(
        requestContext.toolName,
        requestContext.arguments,
      );
      await this.options.audit.emit({
        eventType: 'tool_execution_started',
        requestId: requestContext.requestId,
        mcpRequestId: requestContext.mcpRequestId,
        userId: requestContext.userId,
        userRole: requestContext.userRole,
        agentId: requestContext.agentId,
        toolName: requestContext.toolName,
        decision: decision.decision,
        matchedPolicyId: decision.matchedPolicyId,
        executionStatus: 'started',
      });
      const result = await this.options.toolExecutor.execute(
        requestContext.toolName,
        requestContext.arguments,
      );
      await this.options.audit.emit({
        eventType: 'tool_execution_succeeded',
        requestId: requestContext.requestId,
        mcpRequestId: requestContext.mcpRequestId,
        userId: requestContext.userId,
        userRole: requestContext.userRole,
        agentId: requestContext.agentId,
        toolName: requestContext.toolName,
        decision: decision.decision,
        matchedPolicyId: decision.matchedPolicyId,
        executionStatus: 'succeeded',
        resultSummary: sanitizeAuditResult(result),
      });

      return {
        statusCode: 200,
        body: {
          requestId: decision.requestId,
          decision: decision.decision,
          matchedPolicyId: decision.matchedPolicyId,
          result,
        },
      };
    } catch (error) {
      if (error instanceof ToolArgumentValidationError) {
        return {
          statusCode: 400,
          body: {
            requestId: requestContext.requestId,
            error: error.message,
            issues: error.issues,
          },
        };
      }

      if (error instanceof UnknownToolError) {
        return {
          statusCode: 403,
          body: {
            requestId: requestContext.requestId,
            decision: 'deny',
            matchedPolicyId: null,
            reason: 'The requested tool is not available.',
          },
        };
      }

      try {
        await this.options.audit.emit({
          eventType: 'tool_execution_failed',
          requestId: requestContext.requestId,
          mcpRequestId: requestContext.mcpRequestId,
          userId: requestContext.userId,
          userRole: requestContext.userRole,
          agentId: requestContext.agentId,
          toolName: requestContext.toolName,
          executionStatus: 'failed',
          reason: 'Mock tool execution failed.',
        });
      } catch {
        // The response remains fail-closed if even failure reporting is unavailable.
      }
      return {
        statusCode: 500,
        body: {
          requestId: requestContext.requestId,
          error: 'Mock tool execution failed.',
        },
      };
    }
  }
}

export function createDefaultToolCallService(
  approvalCreator: ApprovalCreator,
  audit: AuditService,
): ToolCallService {
  return new ToolCallService({
    policies: samplePolicies,
    policyEvaluator: evaluatePolicy,
    toolExecutor: defaultToolRegistry,
    approvalCreator,
    now: () => new Date(),
    audit,
  });
}
