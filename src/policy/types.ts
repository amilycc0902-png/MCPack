export type PolicyEffect = 'allow' | 'deny' | 'require_approval';

export interface RequestContext {
  requestId: string;
  /** Original MCP JSON-RPC request ID, used only for cross-boundary correlation. */
  mcpRequestId?: string | number;
  userId: string;
  userRole: string;
  agentId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  timestamp: string;
}

export type PolicyConditionValue = string | number | boolean | null;

export interface PolicyCondition {
  field: `arguments.${string}`;
  operator: 'equals';
  value: PolicyConditionValue;
}

export interface Policy {
  id: string;
  description: string;
  effect: PolicyEffect;
  subjects: string[];
  tools: string[];
  conditions: PolicyCondition[];
  priority: number;
}

export interface PolicyDecision {
  decision: PolicyEffect;
  matchedPolicyId: string | null;
  reason: string;
  requestId: string;
}
