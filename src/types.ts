import type {
  ClientCapabilities,
  Implementation,
  McpHttpHandler,
  Server as ModernServer,
  Tool,
} from '@modelcontextprotocol/server';

// ─── Public Types ───────────────────────────────────────────────────────────

/**
 * Configuration for MCPack wrap mode.
 */
export interface MCPackConfig {
  roles?: RoleConfig;
  defaultRole?: string;
  index?: IndexConfig;
  session?: SessionConfig;
  onToolCall?: (observation: MCPackToolCallObservation) => void;
  /** Optional bootstrap fallback when an upstream tools/list call fails. */
  tools?: Tool[];
}

/**
 * Configuration for MCPack build mode.
 * Extends MCPackConfig with server identity and tool definitions.
 */
export interface MCPackServerConfig extends MCPackConfig {
  name: string;
  version: string;
  tools: MCPackToolDefinition[];
}

/**
 * Context passed to every tool handler invocation.
 */
export interface MCPackHandlerContext {
  toolName: string;
  role: string | undefined;
  protocolVersion: string;
  clientCapabilities: ClientCapabilities;
  /** Self-reported attribution only; it never grants a role or permission. */
  clientInfo?: Implementation;
}

/**
 * Minimal observation hook for tool-call context experiments.
 */
export interface MCPackToolCallObservation {
  toolName: string;
  arguments: Record<string, unknown>;
  protocolVersion: string;
  clientCapabilities: ClientCapabilities;
  /** Self-reported attribution only; it never grants a role or permission. */
  clientInfo?: Implementation;
  userQuery?: unknown;
  requestContext?: unknown;
}

/**
 * A tool definition with an attached handler function for build mode.
 */
export interface MCPackToolDefinition extends Tool {
  handler: (args: Record<string, unknown>, ctx: MCPackHandlerContext) => Promise<unknown>;
}

/**
 * Role configuration mapping role names to allowed tool names or wildcard.
 */
export interface RoleConfig {
  [roleName: string]: string[] | '*';
}

/**
 * Index configuration.
 */
export interface IndexConfig {
  maxResults?: number;
}

/**
 * Session configuration.
 */
export interface SessionConfig {
  ttl?: number;
}

/**
 * Response shape returned by the search_tools tool.
 */
export interface SearchToolResponse {
  tools: SearchResult[];
  total_available: number;
  showing: number;
  /** @deprecated Present only in legacy wrap mode. Build mode is stateless. */
  session_id?: string;
}

/**
 * A single search result entry.
 */
export interface SearchResult {
  name: string;
  loaded: boolean;
  schema?: object;
}

/**
 * Result of calling a tool handler.
 */
export interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  resultType?: 'complete' | 'input_required';
  _meta?: Record<string, unknown>;
}

export interface MCPackResult extends ToolCallResult {
  resultType: 'complete' | 'input_required';
  _meta: Record<string, unknown>;
}

/**
 * Control handle returned by mcpack() for lifecycle management.
 */
export interface MCPackHandle {
  destroy(): void;
  stats(): { sessions: number; tools: number };
}

/**
 * Return value from createMCPackServer() containing the server and control handle.
 */
export interface MCPackServer {
  /** A build-mode server instance for direct/legacy transport integration. */
  server: ModernServer;
  /** Stateless 2026-07-28 HTTP handler. No initialize or session is required. */
  handler: McpHttpHandler;
  handle: MCPackHandle;
}

/** Public v2 composition target accepted by stateless wrap mode. */
export interface MCPackWrapTarget {
  handler: McpHttpHandler;
}

/** Stateless endpoint and lifecycle handle returned by wrap mode. */
export interface MCPackWrappedServer {
  handler: McpHttpHandler;
  handle: MCPackHandle;
}

// ─── Internal Types ─────────────────────────────────────────────────────────

/**
 * An indexed tool entry used internally for search scoring.
 * NOT exported from the package entry point.
 */
export interface ToolIndexEntry {
  name: string;
  description: string;
  keywords: string[];
  schemaKeywords: string[];
  schema: Tool;
}

/**
 * An active session tracking loaded tools and query history.
 * NOT exported from the package entry point.
 */
export interface Session {
  id: string;
  role: string;
  loadedTools: Set<string>;
  queryLog: Array<{ query: string; results: string[]; timestamp: number }>;
  createdAt: number;
  lastActiveAt: number;
}
