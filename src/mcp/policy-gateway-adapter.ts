import { randomUUID } from 'node:crypto';
import type {
  CallToolRequest,
  Implementation,
  RequestId,
} from '@modelcontextprotocol/server';
import type {
  ToolCallRequest,
  ToolCallServiceResponse,
} from '../gateway/types.js';
import type { ToolCallService } from '../gateway/tool-call-service.js';
import type { ApprovalService } from '../approval/approval-service.js';
import { sanitizeAuditResult } from '../audit/sanitize.js';
import type { MCPackResult } from '../types.js';
import {
  validateMCPRequestMetadata,
  type MCPackRequestProtocolContext,
} from './protocol.js';
import { normalizeMCPResult } from './result.js';

/** Explicitly untrusted fixture identity for the local POC and tests only. */
export interface UntrustedPOCPolicyIdentity {
  userId: string;
  userRole: string;
  agentId: string;
}

export interface MCPGatewayAdapterRequest {
  request: CallToolRequest;
  /** Reserved MCP 2026 request metadata envelope. */
  envelope: unknown;
  /** JSON-RPC request ID; never reused as the gateway correlation ID. */
  mcpRequestId: RequestId;
  /** Explicit POC policy fixture. clientInfo is never used for this purpose. */
  identity?: UntrustedPOCPolicyIdentity;
}

export interface PolicyGatewayMCPAdapterOptions {
  toolCallService: Pick<ToolCallService, 'handle'>;
  approvalService?: Pick<ApprovalService, 'get' | 'execute'>;
  serverInfo: Implementation;
  generateGatewayRequestId?: () => string;
}

const CORRELATION_META_KEY = 'com.llvs.mcpack/correlation';
export const MCP_APPROVAL_STATUS_TOOL = 'approvals.status';
export const MCP_APPROVAL_EXECUTE_TOOL = 'approvals.execute';
const APPROVAL_ID_PATTERN = /^approval-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Translates MCP tools/call requests to and from the transport-neutral gateway. */
export class PolicyGatewayMCPAdapter {
  private readonly generateGatewayRequestId: () => string;

  constructor(private readonly options: PolicyGatewayMCPAdapterOptions) {
    this.generateGatewayRequestId =
      options.generateGatewayRequestId ?? (() => `gateway-${randomUUID()}`);
  }

  async handle(input: MCPGatewayAdapterRequest): Promise<MCPackResult> {
    const protocol = validateMCPRequestMetadata(input.envelope);
    const parsed = parseToolCall(input.request);
    if (!parsed) {
      return this.result(
        safeError('Invalid MCP tool call.'),
        input.mcpRequestId,
        undefined,
      );
    }
    if (parsed.name === MCP_APPROVAL_STATUS_TOOL) {
      return this.handleApprovalStatus(parsed.arguments, protocol, input.mcpRequestId);
    }
    if (parsed.name === MCP_APPROVAL_EXECUTE_TOOL) {
      return this.handleApprovalExecution(parsed.arguments, protocol, input.mcpRequestId);
    }
    if (!isFixtureIdentity(input.identity)) {
      return this.result(
        safeError('Policy identity is required.'),
        input.mcpRequestId,
        undefined,
      );
    }

    const gatewayRequestId = this.generateGatewayRequestId();
    const gatewayRequest: ToolCallRequest = {
      requestId: gatewayRequestId,
      mcpRequestId: input.mcpRequestId,
      ...input.identity,
      toolName: parsed.name,
      arguments: parsed.arguments,
    };
    const response = await this.options.toolCallService.handle(gatewayRequest);
    return this.mapResponse(
      response,
      parsed.name,
      protocol,
      input.mcpRequestId,
      gatewayRequestId,
    );
  }

  private handleApprovalStatus(
    args: Record<string, unknown>,
    protocol: MCPackRequestProtocolContext,
    mcpRequestId: RequestId,
  ): MCPackResult {
    const approvalId = parseApprovalId(args);
    if (!approvalId) return this.result(safeError('Invalid approval handle.'), mcpRequestId, undefined);
    if (!this.options.approvalService) {
      return this.result(safeError('Approval continuation is unavailable.'), mcpRequestId, undefined);
    }
    const response = this.options.approvalService.get(approvalId);
    if (response.statusCode !== 200) {
      return this.approvalResult(response, protocol, mcpRequestId, approvalId);
    }
    const status = approvalStatus(response.body.status);
    if (!status) return this.result(safeError('Approval status is unavailable.'), mcpRequestId, undefined);
    return this.approvalResult({
      statusCode: 200,
      body: { ...response.body, result: { approvalId, approvalStatus: status, executed: status === 'executed' } },
    }, protocol, mcpRequestId, approvalId);
  }

  private async handleApprovalExecution(
    args: Record<string, unknown>,
    protocol: MCPackRequestProtocolContext,
    mcpRequestId: RequestId,
  ): Promise<MCPackResult> {
    const approvalId = parseApprovalId(args);
    if (!approvalId) return this.result(safeError('Invalid approval handle.'), mcpRequestId, undefined);
    if (!this.options.approvalService) {
      return this.result(safeError('Approval continuation is unavailable.'), mcpRequestId, undefined);
    }
    const existing = this.options.approvalService.get(approvalId);
    if (existing.statusCode !== 200) {
      return this.approvalResult(existing, protocol, mcpRequestId, approvalId);
    }
    const response = await this.options.approvalService.execute(approvalId);
    return this.approvalResult(response, protocol, mcpRequestId, approvalId, existing.body);
  }

  private approvalResult(
    response: ToolCallServiceResponse,
    protocol: MCPackRequestProtocolContext,
    mcpRequestId: RequestId,
    approvalId: string,
    original = response.body,
  ): MCPackResult {
    const status = approvalStatus(response.body.status);
    const gatewayRequestId = typeof original.requestId === 'string' ? original.requestId : undefined;
    const originMcpRequestId = requestIdValue(original.mcpRequestId);
    const correlation = {
      mcpRequestId,
      ...(originMcpRequestId === undefined ? {} : { originMcpRequestId }),
      ...(gatewayRequestId === undefined ? {} : { gatewayRequestId }),
      approvalId,
      protocolVersion: protocol.protocolVersion,
      ...(protocol.clientInfo === undefined ? {} : { clientInfo: protocol.clientInfo }),
    };
    const meta = { [CORRELATION_META_KEY]: correlation };
    if (response.statusCode === 200) {
      const value = isRecord(response.body.result) && 'approvalStatus' in response.body.result
        ? response.body.result
        : {
            approvalId,
            approvalStatus: status ?? 'executed',
            executed: status === 'executed',
            ...(response.body.result === undefined
              ? {}
              : { result: sanitizeAuditResult(response.body.result) }),
          };
      return this.result({ content: [{ type: 'text', text: JSON.stringify(value) }], _meta: meta }, mcpRequestId, gatewayRequestId);
    }
    return this.result({
      content: [{ type: 'text', text: JSON.stringify({
        approvalId,
        ...(status === undefined ? {} : { approvalStatus: status, executed: status === 'executed' }),
        error: response.statusCode === 404 ? 'Approval is not available.' : 'Approval is not executable.',
      }) }],
      isError: true,
      _meta: meta,
    }, mcpRequestId, gatewayRequestId);
  }

  private mapResponse(
    response: ToolCallServiceResponse,
    toolName: string,
    protocol: MCPackRequestProtocolContext,
    mcpRequestId: RequestId,
    gatewayRequestId: string,
  ): MCPackResult {
    const upstreamMeta = isRecord(response.body._meta)
      ? response.body._meta
      : {};
    const correlation = {
      mcpRequestId,
      gatewayRequestId,
      protocolVersion: protocol.protocolVersion,
      ...(protocol.clientInfo === undefined
        ? {}
        : { clientInfo: protocol.clientInfo }),
    };
    const meta = {
      ...upstreamMeta,
      [CORRELATION_META_KEY]: correlation,
    };

    if (response.statusCode === 200 && response.body.decision === 'allow') {
      return this.result({
        content: [{
          type: 'text',
          text: JSON.stringify({
            decision: 'allow',
            executed: true,
            result: sanitizeAuditResult(response.body.result),
          }),
        }],
        _meta: meta,
      }, mcpRequestId, gatewayRequestId);
    }

    if (response.statusCode === 202 && response.body.decision === 'require_approval') {
      return this.result({
        content: [{
          type: 'text',
          text: JSON.stringify({
            decision: 'require_approval',
            approvalId: response.body.approvalId,
            executed: false,
          }),
        }],
        _meta: meta,
      }, mcpRequestId, gatewayRequestId);
    }

    if (response.statusCode === 403) {
      return this.result({
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
        _meta: meta,
      }, mcpRequestId, gatewayRequestId);
    }

    const message = response.statusCode === 400
      ? 'Invalid tool arguments.'
      : 'Tool call failed.';
    return this.result({
      content: [{ type: 'text', text: message }],
      isError: true,
      _meta: meta,
    }, mcpRequestId, gatewayRequestId);
  }

  private result(
    value: unknown,
    mcpRequestId: RequestId,
    gatewayRequestId: string | undefined,
  ): MCPackResult {
    const normalized = normalizeMCPResult(value, this.options.serverInfo);
    if (isRecord(normalized._meta[CORRELATION_META_KEY])) {
      return normalized;
    }
    normalized._meta[CORRELATION_META_KEY] = {
      mcpRequestId,
      ...(gatewayRequestId === undefined ? {} : { gatewayRequestId }),
    };
    return normalized;
  }
}

function parseToolCall(request: CallToolRequest): {
  name: string;
  arguments: Record<string, unknown>;
} | undefined {
  if (!isRecord(request) || request.method !== 'tools/call') return undefined;
  if (!isRecord(request.params) || !nonEmpty(request.params.name)) {
    return undefined;
  }
  const argumentsValue = request.params.arguments ?? {};
  if (!isRecord(argumentsValue)) return undefined;
  return { name: request.params.name, arguments: argumentsValue };
}

function isFixtureIdentity(
  identity: UntrustedPOCPolicyIdentity | undefined,
): identity is UntrustedPOCPolicyIdentity {
  return identity !== undefined &&
    nonEmpty(identity.userId) &&
    nonEmpty(identity.userRole) &&
    nonEmpty(identity.agentId);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseApprovalId(args: Record<string, unknown>): string | undefined {
  if (Object.keys(args).length !== 1) return undefined;
  return typeof args.approvalId === 'string' && APPROVAL_ID_PATTERN.test(args.approvalId)
    ? args.approvalId
    : undefined;
}

function approvalStatus(value: unknown): 'pending' | 'approved' | 'rejected' | 'executed' | undefined {
  return value === 'pending' || value === 'approved' || value === 'rejected' || value === 'executed'
    ? value
    : undefined;
}

function requestIdValue(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function safeError(message: string) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { CORRELATION_META_KEY };
