import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { Validator } from '@cfworker/json-schema';
import {
  compileTicketSchema,
  type SchemaFailureStage,
  type KeywordDiagnostic,
} from './upstream-schema.js';
import { z } from 'zod';
import { $ZodError as SDKValidationError } from 'zod/v4/core';
import {
  ToolArgumentValidationError,
  UnknownToolError,
  type ToolExecutor,
} from './registry.js';
import { sanitizeAuditResult } from '../audit/sanitize.js';

export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/readonly';
export const UPSTREAM_TOOL = 'search_issues';
const failure = () => new Error('Read-only MCP integration failed.');
/** Optional observation seam; only the opt-in demo supplies an observer. No data. */
export type MCPStage =
  | SchemaFailureStage
  | 'network_or_tls_failed'
  | 'upstream_http_401'
  | 'upstream_http_403'
  | 'upstream_http_404'
  | 'upstream_http_other'
  | 'mcp_handshake_failed'
  | 'environment_configuration_failed'
  | 'capability_validation_failed'
  | 'tool_discovery_failed'
  | 'tool_annotation_failed'
  | 'tool_execution_failed'
  | 'result_validation_failed';
export type MCPStageObserver = (
  stage: MCPStage,
  keyword?: KeywordDiagnostic,
) => void;

function httpStage(status: number): MCPStage {
  if (status === 401) return 'upstream_http_401';
  if (status === 403) return 'upstream_http_403';
  if (status === 404) return 'upstream_http_404';
  return 'upstream_http_other';
}

function observe(
  observer: MCPStageObserver | undefined,
  stage: MCPStage,
  keyword?: KeywordDiagnostic,
): void {
  try {
    if (keyword === undefined) observer?.(stage);
    else observer?.(stage, keyword);
  } catch {
    /* Observation cannot alter execution. */
  }
}
const input = z.object({ query: z.string().trim().min(1).max(1024) }).strict();

export class MCPToolExecutor implements ToolExecutor {
  private closed = false;
  private constructor(
    private readonly client: Client,
    private readonly validator: Validator,
    private readonly timeoutMs: number,
    private readonly observer?: MCPStageObserver,
  ) {}

  static async connect(
    transport: Transport,
    timeoutMs = 5000,
    observer?: MCPStageObserver,
  ): Promise<MCPToolExecutor> {
    observe(observer, 'mcp_handshake_failed');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      throw failure();
    const client = new Client(
      { name: 'mcpack-read-only-pilot', version: '1.0.0' },
      // Avoid the SDK's default AJV warning output for upstream-owned schemas.
      { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    let executor: MCPToolExecutor | undefined;
    try {
      return await deadline(
        async () => {
          try {
            await client.connect(transport, { timeout: timeoutMs });
          } catch (error) {
            // Only the typed HTTP status is inspected, never message/cause/data.
            if (
              error instanceof StreamableHTTPError &&
              typeof error.code === 'number' &&
              Number.isInteger(error.code) &&
              error.code >= 100
            ) {
              observe(observer, httpStage(error.code));
            }
            throw error;
          }
          observe(observer, 'capability_validation_failed');
          if (
            !client.getServerCapabilities()?.tools ||
            !client.getServerVersion()?.name
          )
            throw failure();
          // One bounded catalog snapshot: pagination is intentionally unsupported.
          observe(observer, 'tool_discovery_failed');
          const catalog = await client.listTools({}, { timeout: timeoutMs });
          const matches = catalog.tools.filter(
            (tool) => tool.name === UPSTREAM_TOOL,
          );
          if (catalog.nextCursor || matches.length !== 1) throw failure();
          const tool = matches[0];
          observe(observer, 'tool_annotation_failed');
          if (
            tool.annotations?.readOnlyHint !== true ||
            tool.annotations.destructiveHint === true
          )
            throw failure();
          observe(observer, 'schema_validation_other');
          const validator = compileTicketSchema(
            tool.inputSchema,
            observer
              ? (stage, keyword) => observe(observer, stage, keyword)
              : undefined,
          );
          executor = new MCPToolExecutor(
            client,
            validator,
            timeoutMs,
            observer,
          );
          return executor;
        },
        timeoutMs,
        () => {
          void client.close().catch(() => {});
        },
      );
    } catch {
      if (executor) await executor.close();
      else void client.close().catch(() => {});
      throw failure();
    }
  }

  validate(name: string, args: Record<string, unknown>): void {
    observe(this.observer, 'schema_validation_other');
    if (name !== 'tickets.search') throw new UnknownToolError(name);
    if (this.closed) throw failure();
    const parsed = input.safeParse(args);
    if (!parsed.success) throw new ToolArgumentValidationError(parsed.error);
    if (!this.validator.validate(parsed.data).valid) {
      throw new ToolArgumentValidationError(
        new z.ZodError([
          {
            code: 'custom',
            path: [],
            message: 'Arguments do not match the upstream schema.',
          },
        ]),
      );
    }
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.validate(name, args);
    const forwarded = input.parse(args);
    observe(this.observer, 'tool_execution_failed');
    try {
      return await deadline(
        async () => {
          const resultSchema = this.observer
            ? CallToolResultSchema.superRefine(() => {
                observe(this.observer, 'result_validation_failed');
              })
            : CallToolResultSchema;
          const result = CallToolResultSchema.parse(
            await this.client.callTool(
              { name: UPSTREAM_TOOL, arguments: forwarded },
              resultSchema,
              { timeout: this.timeoutMs },
            ),
          );
          if (result.isError) {
            observe(this.observer, 'tool_execution_failed');
            throw failure();
          }
          observe(this.observer, 'result_validation_failed');
          // Never release raw text or metadata. Only accept a structured search
          // result (GitHub also serializes JSON in one text block).
          let data: unknown = result.structuredContent;
          if (data === undefined) {
            if (
              result.content.length !== 1 ||
              result.content[0].type !== 'text'
            )
              throw failure();
            data = JSON.parse(result.content[0].text);
          }
          const search = z
            .object({
              total_count: z.number().int().nonnegative(),
              items: z.array(
                z.object({
                  id: z.number().int(),
                  title: z.string(),
                  state: z.string(),
                }),
              ),
            })
            .parse(data);
          return sanitizeAuditResult({
            tickets: search.items.map((item) => ({
              ticketId: String(item.id),
              summary: item.title,
              status: item.state,
            })),
            count: search.items.length,
          });
        },
        this.timeoutMs,
        () => {
          void this.close();
        },
      );
    } catch (error) {
      if (error instanceof SDKValidationError) {
        observe(this.observer, 'result_validation_failed');
      }
      await this.close();
      throw failure();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    // Closing must not allow a broken injected transport to hold up failure.
    void this.client.close().catch(() => {});
  }
}

async function deadline<T>(
  run: () => Promise<T>,
  ms: number,
  abort: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort();
          reject(failure());
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Credentials are read only here, never from tool arguments or caller headers. */
export async function connectGitHubFromEnvironment(
  observer?: MCPStageObserver,
): Promise<MCPToolExecutor> {
  observe(observer, 'mcp_handshake_failed');
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (!token) {
    observe(observer, 'environment_configuration_failed');
    throw failure();
  }
  const timeoutMs = Number(process.env.REAL_MCP_TIMEOUT_MS ?? '5000');
  if (
    !/^[A-Za-z0-9_]+$/.test(token) ||
    token === 'replace_with_public_read_only_token'
  )
    throw failure();
  let connecting = true;
  const connectionObserver: MCPStageObserver | undefined = observer
    ? (stage, keyword) => {
        if (stage === 'capability_validation_failed') connecting = false;
        observe(observer, stage, keyword);
      }
    : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(GITHUB_MCP_URL), {
    // Enabled only by the opt-in demo. The normal transport is unchanged.
    ...(observer
      ? {
          fetch: async (url: string | URL, init?: RequestInit) => {
            // Optional background GET/SSE cannot overwrite the required POST outcome.
            if (!connecting || init?.method !== 'POST') return fetch(url, init);
            observe(observer, 'network_or_tls_failed');
            const response = await fetch(url, init);
            observe(
              observer,
              response.ok ? 'mcp_handshake_failed' : httpStage(response.status),
            );
            return response;
          },
        }
      : {}),
    requestInit: {
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-MCP-Readonly': 'true',
        'X-MCP-Tools': UPSTREAM_TOOL,
      },
    },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  try {
    return await MCPToolExecutor.connect(
      transport,
      timeoutMs,
      connectionObserver,
    );
  } finally {
    connecting = false;
  }
}
