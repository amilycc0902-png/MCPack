import type { ApprovalStatus } from '../approval/types.js';
import type { PolicyEffect } from '../policy/types.js';

export type AuditEventType =
  | 'tool_call_received'
  | 'policy_decided'
  | 'tool_call_denied'
  | 'approval_created'
  | 'approval_approved'
  | 'approval_rejected'
  | 'tool_execution_started'
  | 'tool_execution_succeeded'
  | 'tool_execution_failed';

export interface AuditEvent {
  eventId: string;
  eventType: AuditEventType;
  requestId: string;
  userId?: string;
  userRole?: string;
  agentId?: string;
  toolName?: string;
  sanitizedArguments?: Record<string, unknown>;
  decision?: PolicyEffect;
  matchedPolicyId?: string | null;
  reason?: string;
  approvalId?: string;
  approvalStatus?: ApprovalStatus;
  reviewedBy?: string | null;
  executionStatus?: 'started' | 'succeeded' | 'failed';
  resultSummary?: unknown;
  timestamp: string;
}

export type AuditEventInput = Omit<AuditEvent, 'eventId' | 'timestamp'>;

export interface AuditSink {
  emit(event: AuditEvent): Promise<void>;
}
