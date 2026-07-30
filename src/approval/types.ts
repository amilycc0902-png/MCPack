export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed';

export interface Approval {
  approvalId: string;
  requestId: string;
  status: ApprovalStatus;
  requesterUserId: string;
  requesterRole: string;
  agentId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  matchedPolicyId: string;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface ApprovalReview {
  reviewedBy: string;
  reviewerRole: string;
}
