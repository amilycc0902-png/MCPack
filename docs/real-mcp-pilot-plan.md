# Real MCP Integration Pilot Plan

## Objective

Replace exactly one mock read-only tool implementation with one real upstream
MCP tool while preserving the completed M1–M5 Policy Gateway architecture.

```text
MCP client
  -> MCP 2026 request validation and adapter
  -> ToolCallService
  -> unchanged deterministic policy evaluation
  -> allow or deny
  -> routing ToolExecutor
  -> one allowlisted real MCP read-only tool
  -> sanitized result
  -> unchanged AuditSink
```

The recommended pilot maps the existing logical gateway tool
`tickets.search` to one upstream read-only issue/ticket search tool, such as
`search_issues`. The logical name remains `tickets.search`, so the existing
support-agent policy remains unchanged. The exact upstream server is selected
by deployment configuration and must support MCP `2026-07-28`,
`server/discover`, `tools/list`, and stateless `tools/call`.

No write-capable upstream tool is registered or dispatchable. Although the
upstream server may advertise other tools, MCPack admits exactly the configured
read-only tool and treats every other upstream name as unavailable.

## Existing boundaries to preserve

- `ToolExecutor` already provides the required swap point through optional
  `validate(name, arguments)` and asynchronous `execute(name, arguments)`.
  Its contract should not change in the first pilot.
- `ToolCallService` already evaluates policy before validation and execution.
- `ApprovalService` already receives the same executor abstraction. No approval
  behavior changes are needed because the pilot tool is allow-only and
  read-only.
- Audit emission and recursive sanitization already surround execution.
- The MCP adapter and Fastify routes depend on `ToolCallService`, not a concrete
  executor. Neither protocol mapping nor routes need modification.

## Pilot tool and safety constraints

Use one upstream issue/ticket search operation with a JSON Schema compatible
with the existing `tickets.search` input, minimally:

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

The upstream operation must be demonstrably read-only. Before enabling it:

1. Pin the upstream server/version used by the pilot.
2. Record its discovered server identity and capabilities.
3. Confirm the selected tool has no write or destructive semantics.
4. Configure an exact logical-to-upstream name mapping.
5. Reject startup if the tool is absent, its schema is incompatible, or the
   upstream protocol version is unsupported.

Do not dynamically import every discovered tool into the gateway policy or
catalog. Discovery is verification, not automatic authorization.

## Proposed changes

### 1. Add the real MCP executor

| Item | Plan |
| --- | --- |
| Exact files | New `src/tools/mcp-tool-executor.ts`; `package.json`; `package-lock.json` only if a runtime JSON Schema validator must be added or moved from development dependencies. |
| Change | Implement `ToolExecutor` over an injected fetch-compatible MCP endpoint. A static async factory performs `server/discover` and `tools/list`, validates MCP `2026-07-28`, selects exactly one configured upstream tool, compiles its schema, and returns a ready executor. `validate` checks current arguments against the cached discovered schema. `execute` sends a fresh stateless `tools/call` request with required per-request metadata and the configured upstream tool name. |
| Complexity | Medium. The request shapes already exist, but startup discovery, schema compilation, timeouts, and safe result extraction need careful handling. |
| Risk | Medium-high. The main risks are protocol incompatibility, accepting an unsafe discovered tool, leaking upstream errors, or confusing upstream identity with authorization. Exact allowlisting and fail-closed startup reduce these risks. |
| Tests | Discovery succeeds; missing tool fails startup; unsupported protocol fails startup; incompatible schema fails startup; valid arguments pass; invalid arguments never call upstream; one execution sends one `tools/call`; upstream metadata is handled without becoming policy identity. |
| Configuration | `REAL_MCP_URL`; `REAL_MCP_UPSTREAM_TOOL`; fixed or validated `REAL_MCP_GATEWAY_TOOL=tickets.search`; `REAL_MCP_TIMEOUT_MS`; optional credential environment variable or injected header provider. No secret values in repository files. |

Use the public Web `fetch` boundary rather than SDK private handler maps. Each
upstream request must include MCP method/name headers and required per-request
protocol metadata. Do not send or accept `Mcp-Session-Id`, initialize, or
`notifications/initialized`.

### 2. Add an exact routing executor

| Item | Plan |
| --- | --- |
| Exact files | New `src/tools/routing-tool-executor.ts`; optionally export its types from `src/index.ts` only if the pilot is intended as a public library feature. |
| Change | Implement `ToolExecutor` composition with an immutable map from logical tool name to executor. Route only `tickets.search` to the real executor; route existing mock refund/customer tools to `defaultToolRegistry`. Unknown names throw the existing opaque `UnknownToolError`. Both `validate` and `execute` use the same route. |
| Complexity | Small. |
| Risk | Low-medium. A validation/execution routing mismatch could validate one implementation and execute another, so both methods must resolve through one shared lookup function. |
| Tests | Real logical tool routes once; mock tools remain mock; unknown tool throws without calling either executor; validation and execution select the same target; no prefix or wildcard routing. |
| Configuration | A single exact mapping: `tickets.search -> configured upstream tool`. No dynamic routing from caller-controlled arguments. |

This composition means mock and real executors remain interchangeable without
changing `ToolCallService`, `ApprovalService`, or policy evaluation.

### 3. Add safe upstream failure and timeout types

| Item | Plan |
| --- | --- |
| Exact files | Prefer definitions local to `src/tools/mcp-tool-executor.ts`; create `src/tools/executor-errors.ts` only if more than one executor needs them. Add focused assertions in `tests/tools/mcp-tool-executor.test.ts`. |
| Change | Convert timeout, DNS/refusal, non-2xx HTTP, malformed JSON-RPC, upstream MCP error, identity conflict, and connection abort into one internal typed execution failure. Preserve diagnostic causes only inside the process. The gateway receives a generic execution failure and continues using its existing sanitized response/audit path. |
| Complexity | Small-medium. |
| Risk | Medium. Raw response bodies, URLs with credentials, authorization headers, stack traces, and vendor error messages must never enter MCP results or audit events. |
| Tests | Timeout aborts; refused connection fails safely; malformed response fails safely; upstream error text and credentials are absent from gateway response and audit; no retry occurs automatically. |
| Configuration | `REAL_MCP_TIMEOUT_MS`, recommended initial value `5000`; optional non-secret upstream label for diagnostics. |

The pilot should not automatically retry `tools/call`. Even for a read-only
operation, implicit retry obscures execution counts and complicates failure
evidence. A caller may issue a new request explicitly.

### 4. Add an opt-in pilot composition root

| Item | Plan |
| --- | --- |
| Exact files | New `src/demo/real-mcp-pilot.ts`; new `src/config/real-mcp-pilot.ts` if environment parsing is large enough to justify separation; `package.json`; `.env.example`; `README.md`. |
| Change | Read and validate configuration, connect/discover the one upstream tool, construct the routing executor, and inject it into the existing `ApprovalService` and `ToolCallService`. Reuse `PolicyGatewayMCPAdapter`, existing policies, audit service, mock registry, and fixture identity. Add `npm run demo:mcp:real-pilot`. Keep the existing `demo:mcp` and `demo:mcp:e2e` unchanged as offline regression demonstrations. |
| Complexity | Medium. |
| Risk | Medium. Startup must fail closed before accepting requests when discovery or configuration fails. The demo must not print tokens, authorization headers, or full sensitive upstream results. |
| Tests | Missing configuration fails before server creation; unavailable upstream fails startup; configured read-only tool starts; existing mock demo command remains valid. |
| Configuration | See the configuration section below. `.env.example` contains names and safe placeholders only. Runtime secrets come from the shell or a local ignored environment file. |

Do not modify `src/app.ts`, `src/http/*`, or Fastify route contracts. If a later
deployment needs the real executor behind Fastify, add dependency injection to
the application factory in a separate phase rather than coupling the pilot to
HTTP routes now.

### 5. Add pilot integration and regression tests

| Item | Plan |
| --- | --- |
| Exact files | New `tests/tools/mcp-tool-executor.test.ts`; new `tests/mcp/real-mcp-pilot.test.ts`; existing tests remain unchanged unless a shared fixture is extracted without behavior changes. |
| Change | Use an in-process fetch-compatible fake upstream MCP handler. It should behave like a real protocol peer—support discovery/list/call and record calls—but never require network access or credentials in CI. One optional manually run smoke test may target the configured real server and must not run in the default suite. |
| Complexity | Medium. |
| Risk | Low. The main concern is writing a fake that bypasses protocol validation; integration tests must send the same headers, metadata, and JSON-RPC shapes as the real executor. |
| Tests | See the required conformance matrix below. |
| Configuration | Default tests use no environment variables. An opt-in smoke test uses the same runtime variables as the demo and is skipped unless explicitly enabled. |

## Required conformance matrix

| Required behavior | Test location and assertion |
| --- | --- |
| Allowed real tool executes | `tests/mcp/real-mcp-pilot.test.ts`: support-agent `tickets.search` produces allow, invokes upstream `tools/call` exactly once, returns a sanitized normalized result, and emits success audit events. |
| Denied real tool never reaches upstream | Use a policy fixture that denies `tickets.search` for a restricted role; assert policy decision and opaque result, with zero upstream calls. The policy evaluator itself remains unchanged. |
| Unknown tool never executes | Request an unregistered logical name; assert opaque denial and zero upstream discovery/call dispatch beyond startup discovery. |
| Upstream failure is safe | Make the upstream return an MCP error containing a secret marker; assert generic gateway error, sanitized failure audit, and absence of the marker. |
| Policy runs before execution | Spy on the evaluator and upstream handler; assert evaluator completes before any upstream `tools/call`. Deny must produce no upstream call. |
| Existing mock demo still works | Run the existing M5 suite and `npm run demo:mcp:e2e`; retain current mock execution counts and outputs. |
| Argument validation | Invalid `query` fails before upstream `tools/call`; the schema used is the discovered upstream schema, not a handwritten duplicate. |
| Timeout/unavailable server | Timeout and connection failure return safe errors, emit sanitized failure audit evidence, and never fall back to an ungoverned direct call. |

All existing M1–M5 tests must remain green. Required validation after each
implementation step:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run demo:mcp
npm run demo:mcp:e2e
```

Then run the opt-in real pilot against the configured server:

```bash
npm run demo:mcp:real-pilot
```

## Configuration and credential handling

Recommended environment contract:

```text
REAL_MCP_URL=https://localhost-or-approved-pilot-host/mcp
REAL_MCP_GATEWAY_TOOL=tickets.search
REAL_MCP_UPSTREAM_TOOL=search_issues
REAL_MCP_TIMEOUT_MS=5000
REAL_MCP_AUTH_TOKEN=<supplied at runtime only, if required>
REAL_MCP_SMOKE_TEST=1                 # only for an explicit manual smoke test
```

Rules:

- Reject non-HTTPS remote URLs; permit HTTP only for loopback development.
- Never put a token, authorization header, cookie, or credential-bearing URL in
  source, tests, snapshots, `.env.example`, logs, errors, results, or audit data.
- Prefer a least-privilege, read-only pilot credential with access only to a
  non-production project. Do not use a developer's broad production token.
- Construct authorization headers in memory from the environment and ensure
  sanitizers cover the configured header name.
- Keep local `.env` files ignored. The repository should contain only placeholder
  variable names.
- Validate that `REAL_MCP_GATEWAY_TOOL` is exactly `tickets.search`; do not allow
  configuration to replace an arbitrary governed tool during this pilot.

## Discovery and schema behavior

Discovery happens once during pilot startup and produces an immutable snapshot:

1. Send `server/discover` as the first upstream request.
2. Verify protocol `2026-07-28` and record non-sensitive server identity.
3. Send `tools/list` with per-request metadata.
4. Select the exact configured upstream name.
5. Reject write/destructive annotations when the upstream provides them, but do
   not rely on annotations alone; the operator must explicitly approve the tool.
6. Compile and cache that tool's complete input schema.
7. Start the gateway only after all checks pass.

Do not refresh the catalog automatically in the first pilot. A schema change
requires a controlled restart and produces an obvious startup failure rather
than silently changing accepted arguments.

## Failure behavior

| Failure | Required outcome |
| --- | --- |
| Upstream unavailable at startup | Pilot does not start. Existing offline mock demos remain available. |
| Discovery/version/schema mismatch | Pilot does not start and reports a generic configuration/compatibility error without credentials or response bodies. |
| Timeout during `tools/call` | Abort at the configured deadline; return the existing generic gateway execution failure; emit sanitized `tool_execution_failed`. |
| Connection loss or malformed response | Fail closed exactly as a tool execution failure; never return partial upstream content. |
| Upstream MCP error | Do not expose vendor message/data; retain only a safe internal category and generic external error. |
| Audit delivery failure | Preserve current fail-closed behavior. Do not execute if required pre-execution audit delivery fails. |
| Unknown/denied logical tool | Never dispatch upstream. Preserve hidden-tool opacity. |

## Smallest recommended first implementation

Implement in this order:

1. Add `MCPToolExecutor` with injected fetch, startup discovery, exact one-tool
   allowlisting, cached schema validation, timeout, and safe errors.
2. Add `RoutingToolExecutor` mapping only `tickets.search` to the real executor
   and all other existing tools to `defaultToolRegistry`.
3. Prove the behavior with an in-process MCP upstream in the two new test files.
4. Add the opt-in `demo:mcp:real-pilot` composition and environment validation.
5. Run the real smoke demo against one approved read-only upstream server.

This is the smallest useful slice because it changes only execution wiring. It
does not change policies, approvals, audit semantics, MCP result mapping,
Fastify routes, mock implementations, or the existing offline demonstrations.

## Explicitly deferred

- More than one real tool or dynamic tool admission.
- Write/destructive tools and approval-gated real side effects.
- Production authentication or identity mapping.
- Durable approval, execution, or audit storage.
- Automatic discovery refresh or subscriptions.
- Automatic retries, circuit breakers, load balancing, or multi-process
  idempotency.
- Credential management products or committed credentials.
- Streamable HTTP ownership by the Fastify application.
- OpenTelemetry, dashboards, A2A, and SQL analysis.
