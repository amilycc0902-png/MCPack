import {
  connectGitHubFromEnvironment,
  type MCPStage,
  type MCPStageObserver,
} from '../tools/mcp-tool-executor.js';
import type { ToolExecutor } from '../tools/registry.js';
import type { ToolCallServiceResponse } from '../gateway/types.js';
import { createRealMCPPilot } from './real-mcp-composition.js';
import {
  formatKeywordDiagnostic,
  type KeywordDiagnostic,
} from '../tools/upstream-schema.js';

type DemoStage = MCPStage | 'policy_denied';
const stages: readonly DemoStage[] = [
  'network_or_tls_failed',
  'upstream_http_401',
  'upstream_http_403',
  'upstream_http_404',
  'upstream_http_other',
  'mcp_handshake_failed',
  'environment_configuration_failed',
  'capability_validation_failed',
  'tool_discovery_failed',
  'tool_annotation_failed',
  'unsupported_schema_dialect',
  'unsupported_schema_keyword',
  'unsupported_schema_value_type',
  'query_property_missing',
  'query_property_not_string',
  'query_not_required',
  'fixture_validation_failed',
  'schema_validator_construction_failed',
  'schema_validation_other',
  'policy_denied',
  'tool_execution_failed',
  'result_validation_failed',
];

/** Runtime allowlist: never format an Error, payload, or unchecked stage value. */
export function formatDemoFailure(stage: unknown, keyword?: unknown): string {
  if (stage === 'unsupported_schema_keyword') {
    return formatKeywordDiagnostic(keyword);
  }
  return typeof stage === 'string' && stages.includes(stage as DemoStage)
    ? stage
    : 'tool_execution_failed';
}

export function isLiveSuccess(
  response: ToolCallServiceResponse,
  executed: unknown,
): boolean {
  return (
    response.statusCode === 200 &&
    response.body.decision === 'allow' &&
    executed === true
  );
}

interface DemoDependencies {
  connect?: (
    observer: MCPStageObserver,
  ) => Promise<ToolExecutor & { close(): Promise<void> }>;
  createPilot?: typeof createRealMCPPilot;
}

/** Demo-only reporting boundary. Returns a single constant message, never data. */
export async function runRealMCPDemo(
  dependencies: DemoDependencies = {},
): Promise<{ exitCode: 0 | 1; message: string }> {
  let stage: DemoStage = 'mcp_handshake_failed';
  let keyword: KeywordDiagnostic | undefined;
  let upstream: (ToolExecutor & { close(): Promise<void> }) | undefined;
  try {
    upstream = await (dependencies.connect ?? connectGitHubFromEnvironment)(
      (next, nextKeyword) => {
        stage = next;
        keyword =
          next === 'unsupported_schema_keyword' ? nextKeyword : undefined;
      },
    );
    let successfulExecutions = 0;
    const connected = upstream;
    const observed: ToolExecutor = {
      validate: (name, args) => connected.validate?.(name, args),
      execute: async (name, args) => {
        const result = await connected.execute(name, args);
        if (name === 'tickets.search') successfulExecutions += 1;
        return result;
      },
    };
    const pilot = (dependencies.createPilot ?? createRealMCPPilot)(observed);
    stage = 'tool_execution_failed';
    const response = await pilot.toolCallService.handle({
      requestId: 'real-pilot-search',
      userId: 'support-1',
      userRole: 'support-agent',
      agentId: 'support-agent-1',
      toolName: 'tickets.search',
      arguments: { query: 'repo:github/github-mcp-server is:issue is:open' },
    });
    if (
      response.body.decision === 'deny' ||
      response.body.decision === 'require_approval'
    ) {
      stage = 'policy_denied';
    } else if (isLiveSuccess(response, successfulExecutions === 1)) {
      return { exitCode: 0, message: 'Live search succeeded' };
    } else if (response.statusCode === 200) {
      stage = 'result_validation_failed';
    }
    return { exitCode: 1, message: formatDemoFailure(stage, keyword) };
  } catch {
    return { exitCode: 1, message: formatDemoFailure(stage, keyword) };
  } finally {
    try {
      await upstream?.close();
    } catch {
      /* Never expose cleanup errors. */
    }
  }
}
