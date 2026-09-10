import type { Approval } from './types.js';

type ReviewOutcome =
  | { kind: 'updated'; approval: Approval }
  | { kind: 'missing' }
  | { kind: 'conflict'; approval: Approval };

export type ClaimOutcome =
  | { kind: 'claimed'; approval: Approval }
  | { kind: 'missing' }
  | { kind: 'conflict'; approval: Approval };

function copyApproval(approval: Approval): Approval {
  return structuredClone(approval);
}

export class InMemoryApprovalRepository {
  private readonly approvals = new Map<string, Approval>();
  private readonly executionClaims = new Set<string>();

  create(approval: Approval): Approval {
    if (this.approvals.has(approval.approvalId)) {
      throw new Error(`Duplicate approval ID: ${approval.approvalId}`);
    }

    const storedApproval = copyApproval(approval);
    this.approvals.set(approval.approvalId, storedApproval);
    return copyApproval(storedApproval);
  }

  get(approvalId: string): Approval | undefined {
    const approval = this.approvals.get(approvalId);
    return approval ? copyApproval(approval) : undefined;
  }

  reviewPending(
    approvalId: string,
    status: 'approved' | 'rejected',
    reviewedBy: string,
    reviewedAt: string,
  ): ReviewOutcome {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      return { kind: 'missing' };
    }

    if (approval.status !== 'pending') {
      return { kind: 'conflict', approval: copyApproval(approval) };
    }

    approval.status = status;
    approval.reviewedBy = reviewedBy;
    approval.reviewedAt = reviewedAt;
    return { kind: 'updated', approval: copyApproval(approval) };
  }

  claimApproved(approvalId: string): ClaimOutcome {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      return { kind: 'missing' };
    }

    if (
      approval.status !== 'approved' ||
      this.executionClaims.has(approvalId)
    ) {
      return { kind: 'conflict', approval: copyApproval(approval) };
    }

    this.executionClaims.add(approvalId);
    return { kind: 'claimed', approval: copyApproval(approval) };
  }

  markExecuted(approvalId: string): Approval | undefined {
    const approval = this.approvals.get(approvalId);
    if (!approval || !this.executionClaims.has(approvalId)) {
      return undefined;
    }

    approval.status = 'executed';
    this.executionClaims.delete(approvalId);
    return copyApproval(approval);
  }

  releaseExecutionClaim(approvalId: string): void {
    this.executionClaims.delete(approvalId);
  }
}
