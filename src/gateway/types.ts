import type {
  Policy,
  PolicyDecision,
  RequestContext,
} from '../policy/types.js';

export interface ToolCallRequest {
  requestId: string;
  /** Original MCP JSON-RPC request ID when the call entered through MCP. */
  mcpRequestId?: string | number;
  userId: string;
  userRole: string;
  agentId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallServiceResponse {
  statusCode: 200 | 201 | 202 | 400 | 403 | 404 | 409 | 500;
  body: Record<string, unknown>;
}

export interface ApprovalCreator {
  createForDecision(
    requestContext: RequestContext,
    decision: PolicyDecision,
  ): Promise<{ approvalId: string }>;
}

export type PolicyEvaluator = (
  requestContext: RequestContext,
  policies: readonly Policy[],
) => PolicyDecision;
