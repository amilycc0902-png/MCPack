import { randomUUID } from 'node:crypto';
import type {
  Policy,
  PolicyDecision,
  RequestContext,
} from '../policy/types.js';
import {
  ToolArgumentValidationError,
  type ToolExecutor,
} from '../tools/registry.js';
import type {
  PolicyEvaluator,
  ToolCallRequest,
  ToolCallServiceResponse,
} from '../gateway/types.js';
import { type ClaimOutcome, InMemoryApprovalRepository } from './repository.js';
import type { Approval, ApprovalReview } from './types.js';
import { AuditService } from '../audit/audit-service.js';
import { sanitizeAuditData, sanitizeAuditResult } from '../audit/sanitize.js';

export interface ApprovalServiceOptions {
  repository: InMemoryApprovalRepository;
  toolExecutor: ToolExecutor;
  policies: readonly Policy[];
  policyEvaluator: PolicyEvaluator;
  now: () => Date;
  generateApprovalId: () => string;
  audit: AuditService;
}

function approvalNotFound(approvalId: string): ToolCallServiceResponse {
  return {
    statusCode: 404,
    body: {
      approvalId,
      error: 'Approval not found.',
    },
  };
}

function approvalConflict(approval: Approval): ToolCallServiceResponse {
  return {
    statusCode: 409,
    body: {
      approvalId: approval.approvalId,
      requestId: approval.requestId,
      status: approval.status,
      error: `Approval cannot be changed or executed from status "${approval.status}".`,
    },
  };
}

export class ApprovalService {
  private readonly options: ApprovalServiceOptions;

  constructor(options: ApprovalServiceOptions) {
    this.options = options;
  }

  async createForDecision(
    requestContext: RequestContext,
    decision: PolicyDecision,
  ): Promise<Approval> {
    if (
      decision.decision !== 'require_approval' ||
      decision.matchedPolicyId === null
    ) {
      throw new Error(
        'An approval requires a matched require_approval policy.',
      );
    }

    const approval: Approval = {
      approvalId: this.options.generateApprovalId(),
      requestId: requestContext.requestId,
      ...(requestContext.mcpRequestId === undefined
        ? {}
        : { mcpRequestId: requestContext.mcpRequestId }),
      status: 'pending',
      requesterUserId: requestContext.userId,
      requesterRole: requestContext.userRole,
      agentId: requestContext.agentId,
      toolName: requestContext.toolName,
      arguments: structuredClone(requestContext.arguments),
      matchedPolicyId: decision.matchedPolicyId,
      createdAt: this.options.now().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
    };
    await this.options.audit.emit({
      eventType: 'approval_created',
      requestId: approval.requestId,
      mcpRequestId: approval.mcpRequestId,
      userId: approval.requesterUserId,
      userRole: approval.requesterRole,
      agentId: approval.agentId,
      toolName: approval.toolName,
      sanitizedArguments: sanitizeAuditData(approval.arguments),
      decision: decision.decision,
      matchedPolicyId: approval.matchedPolicyId,
      reason: decision.reason,
      approvalId: approval.approvalId,
      approvalStatus: approval.status,
    });
    return this.options.repository.create(approval);
  }

  async requestApproval(
    request: ToolCallRequest,
  ): Promise<ToolCallServiceResponse> {
    const requestContext: RequestContext = {
      ...request,
      timestamp: this.options.now().toISOString(),
    };
    const decision = this.options.policyEvaluator(
      requestContext,
      this.options.policies,
    );

    if (decision.decision !== 'require_approval') {
      return {
        statusCode: 409,
        body: {
          requestId: request.requestId,
          decision: decision.decision,
          matchedPolicyId: decision.matchedPolicyId,
          reason: decision.reason,
          error: 'The request does not require approval.',
        },
      };
    }

    try {
      const approval = await this.createForDecision(
        requestContext,
        decision,
      );
      return {
        statusCode: 201,
        body: approval as unknown as Record<string, unknown>,
      };
    } catch {
      return auditFailure(request.requestId);
    }
  }

  get(approvalId: string): ToolCallServiceResponse {
    const approval = this.options.repository.get(approvalId);
    return approval
      ? {
          statusCode: 200,
          body: approval as unknown as Record<string, unknown>,
        }
      : approvalNotFound(approvalId);
  }

  async approve(
    approvalId: string,
    review: ApprovalReview,
  ): Promise<ToolCallServiceResponse> {
    return this.review(approvalId, review, 'approved');
  }

  async reject(
    approvalId: string,
    review: ApprovalReview,
  ): Promise<ToolCallServiceResponse> {
    return this.review(approvalId, review, 'rejected');
  }

  async execute(approvalId: string): Promise<ToolCallServiceResponse> {
    const claim = this.options.repository.claimApproved(approvalId);
    if (claim.kind === 'missing') {
      return approvalNotFound(approvalId);
    }
    if (claim.kind === 'conflict') {
      return approvalConflict(claim.approval);
    }

    return this.executeClaim(claim);
  }

  private async review(
    approvalId: string,
    review: ApprovalReview,
    status: 'approved' | 'rejected',
  ): Promise<ToolCallServiceResponse> {
    if (review.reviewerRole !== 'team-lead') {
      return {
        statusCode: 403,
        body: {
          approvalId,
          error: 'Only the team-lead role may review approvals.',
        },
      };
    }

    const existing = this.options.repository.get(approvalId);
    if (!existing) {
      return approvalNotFound(approvalId);
    }
    if (existing.status !== 'pending') {
      return approvalConflict(existing);
    }

    try {
      await this.options.audit.emit({
        eventType:
          status === 'approved' ? 'approval_approved' : 'approval_rejected',
        requestId: existing.requestId,
        mcpRequestId: existing.mcpRequestId,
        userId: existing.requesterUserId,
        userRole: existing.requesterRole,
        agentId: existing.agentId,
        toolName: existing.toolName,
        matchedPolicyId: existing.matchedPolicyId,
        approvalId: existing.approvalId,
        approvalStatus: status,
        reviewedBy: review.reviewedBy,
      });
    } catch {
      return auditFailure(existing.requestId, existing.approvalId);
    }

    const outcome = this.options.repository.reviewPending(
      approvalId,
      status,
      review.reviewedBy,
      this.options.now().toISOString(),
    );
    if (outcome.kind === 'missing') {
      return approvalNotFound(approvalId);
    }
    if (outcome.kind === 'conflict') {
      return approvalConflict(outcome.approval);
    }

    return {
      statusCode: 200,
      body: outcome.approval as unknown as Record<string, unknown>,
    };
  }

  private async executeClaim(
    claim: Extract<ClaimOutcome, { kind: 'claimed' }>,
  ): Promise<ToolCallServiceResponse> {
    try {
      await this.options.audit.emit({
        eventType: 'tool_execution_started',
        requestId: claim.approval.requestId,
        mcpRequestId: claim.approval.mcpRequestId,
        userId: claim.approval.requesterUserId,
        userRole: claim.approval.requesterRole,
        agentId: claim.approval.agentId,
        toolName: claim.approval.toolName,
        sanitizedArguments: sanitizeAuditData(claim.approval.arguments),
        matchedPolicyId: claim.approval.matchedPolicyId,
        approvalId: claim.approval.approvalId,
        approvalStatus: claim.approval.status,
        reviewedBy: claim.approval.reviewedBy,
        executionStatus: 'started',
      });
      const result = await this.options.toolExecutor.execute(
        claim.approval.toolName,
        claim.approval.arguments,
      );
      const executedApproval = this.options.repository.markExecuted(
        claim.approval.approvalId,
      );

      if (!executedApproval) {
        throw new Error('Approval execution claim was lost.');
      }

      try {
        await this.options.audit.emit({
          eventType: 'tool_execution_succeeded',
          requestId: executedApproval.requestId,
          mcpRequestId: executedApproval.mcpRequestId,
          userId: executedApproval.requesterUserId,
          userRole: executedApproval.requesterRole,
          agentId: executedApproval.agentId,
          toolName: executedApproval.toolName,
          matchedPolicyId: executedApproval.matchedPolicyId,
          approvalId: executedApproval.approvalId,
          approvalStatus: executedApproval.status,
          reviewedBy: executedApproval.reviewedBy,
          executionStatus: 'succeeded',
          resultSummary: sanitizeAuditResult(result),
        });
      } catch {
        return auditFailure(
          executedApproval.requestId,
          executedApproval.approvalId,
        );
      }

      return {
        statusCode: 200,
        body: {
          approvalId: executedApproval.approvalId,
          requestId: executedApproval.requestId,
          status: executedApproval.status,
          result,
        },
      };
    } catch (error) {
      this.options.repository.releaseExecutionClaim(claim.approval.approvalId);

      if (error instanceof ToolArgumentValidationError) {
        return {
          statusCode: 400,
          body: {
            approvalId: claim.approval.approvalId,
            requestId: claim.approval.requestId,
            error: error.message,
            issues: error.issues,
          },
        };
      }

      try {
        await this.options.audit.emit({
          eventType: 'tool_execution_failed',
          requestId: claim.approval.requestId,
          mcpRequestId: claim.approval.mcpRequestId,
          userId: claim.approval.requesterUserId,
          userRole: claim.approval.requesterRole,
          agentId: claim.approval.agentId,
          toolName: claim.approval.toolName,
          matchedPolicyId: claim.approval.matchedPolicyId,
          approvalId: claim.approval.approvalId,
          approvalStatus: claim.approval.status,
          reviewedBy: claim.approval.reviewedBy,
          executionStatus: 'failed',
          reason: 'Approved mock tool execution failed.',
        });
      } catch {
        // Preserve the deterministic failure response when the sink is down.
      }
      return {
        statusCode: 500,
        body: {
          approvalId: claim.approval.approvalId,
          requestId: claim.approval.requestId,
          error: 'Approved mock tool execution failed.',
        },
      };
    }
  }
}

export function createDefaultApprovalService(
  toolExecutor: ToolExecutor,
  policies: readonly Policy[],
  policyEvaluator: PolicyEvaluator,
  audit: AuditService,
): ApprovalService {
  return new ApprovalService({
    repository: new InMemoryApprovalRepository(),
    toolExecutor,
    policies,
    policyEvaluator,
    now: () => new Date(),
    generateApprovalId: () => `approval-${randomUUID()}`,
    audit,
  });
}

function auditFailure(
  requestId: string,
  approvalId?: string,
): ToolCallServiceResponse {
  return {
    statusCode: 500,
    body: {
      requestId,
      ...(approvalId ? { approvalId } : {}),
      error: 'Required audit delivery failed.',
    },
  };
}
