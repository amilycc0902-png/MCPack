export { mcpack } from './wrap.js';
export { createMCPackServer } from './build.js';

export type {
  MCPackConfig,
  MCPackServerConfig,
  MCPackToolDefinition,
  MCPackHandlerContext,
  MCPackServer,
  RoleConfig,
  IndexConfig,
  SessionConfig,
  SearchToolResponse,
  SearchResult,
  ToolCallResult,
  MCPackResult,
  MCPackHandle,
  MCPackWrapTarget,
  MCPackWrappedServer,
} from './types.js';

export {
  SUPPORTED_MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  MissingMCPRequestMetadataError,
  validateMCPRequestMetadata,
} from './mcp/protocol.js';

export {
  PolicyGatewayMCPAdapter,
  CORRELATION_META_KEY,
  MCP_APPROVAL_STATUS_TOOL,
  MCP_APPROVAL_EXECUTE_TOOL,
} from './mcp/policy-gateway-adapter.js';
export type {
  MCPGatewayAdapterRequest,
  PolicyGatewayMCPAdapterOptions,
  UntrustedPOCPolicyIdentity,
} from './mcp/policy-gateway-adapter.js';
