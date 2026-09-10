# MCPack

## Policy Gateway POC

The Policy Gateway POC currently provides the local scaffold, a health endpoint, a transport-neutral deterministic policy evaluator, guarded mock execution, an in-memory human approval workflow, and replaceable sanitized lifecycle auditing. Real MCP integration and output redaction are not implemented yet.

The policy evaluator supports subject matching, exact or wildcard tool matching, deterministic argument equality conditions, priority ordering, safe effect precedence for ties, and default denial. Sample policies live in `src/policy/sample-policies.ts`.

### Requirements

- Node.js 22 or newer
- npm

### Local setup

```bash
npm install
npm run dev
```

The development server binds to `127.0.0.1:3000` by default. Verify it with:

```bash
curl http://127.0.0.1:3000/health
```

Expected response:

```json
{
  "status": "ok"
}
```

### Guarded mock tool calls

`POST /v1/tools/call` validates the untrusted test request, evaluates deterministic local policy, and executes a mock tool only when the decision is `allow`.

```bash
curl -X POST http://127.0.0.1:3000/v1/tools/call \
  -H "content-type: application/json" \
  -d '{
    "requestId": "req-001",
    "userId": "user-001",
    "userRole": "support-agent",
    "agentId": "support-agent-01",
    "toolName": "tickets.search",
    "arguments": {
      "query": "payment failed"
    }
  }'
```

The available deterministic mock implementations are `tickets.search`, `customers.get`, and `refunds.execute`. The current sample policy allows support agents to search tickets, denies support-agent refunds, and marks billing-agent refunds as requiring approval.

### Local approvals

Billing-agent refund calls return an `approvalId` and remain pending. Approval identity is explicitly untrusted test context: only a request body declaring `reviewerRole: "team-lead"` may approve or reject.

```bash
curl -X POST http://127.0.0.1:3000/v1/approvals/APPROVAL_ID/approve \
  -H "content-type: application/json" \
  -d '{"reviewedBy":"lead-001","reviewerRole":"team-lead"}'

curl -X POST http://127.0.0.1:3000/v1/approvals/APPROVAL_ID/execute
```

Approvals are held only in process memory and disappear when the server restarts. Approved mock calls execute at most once.

### Audit integration

Gateway and approval services emit standardized `AuditEvent` objects through the transport-neutral `AuditSink` interface:

```ts
interface AuditSink {
  emit(event: AuditEvent): Promise<void>;
}
```

`InMemoryAuditSink` is the local demonstration and test adapter. Zaid's audit tool can replace it by implementing this one interface and passing that adapter to `buildApp({ auditSink })`; policy, approval, and execution logic do not need to change.

Audit arguments and result summaries recursively replace fields named `password`, `token`, `secret`, `authorization`, or `email` with `[REDACTED]`. This is deterministic field-name sanitization for the POC, not semantic secret detection.

Required audit delivery is fail-closed before tool execution. If receipt, decision, approval-creation, or execution-start delivery fails, the operation returns an error and the tool does not run. If success-event delivery fails after a mock tool has already completed, the API returns an audit error; approved calls remain marked `executed` to prevent duplicate execution. Failed tool execution attempts produce a failure event when the sink is available.

Run the complete local scenario with:

```bash
npm run demo
```

The demo prints allow, deny, approval, and approved execution responses followed by the sanitized audit events.

### MCP 2026 Policy Gateway adapter

Phase M3 adds a transport boundary that maps an MCP `tools/call` request into
the existing `ToolCallService`. The adapter requires explicit untrusted POC
identity (`userId`, `userRole`, and `agentId`) separately from MCP `clientInfo`,
mints an independent gateway correlation ID, and maps allow, opaque deny, and
require-approval outcomes into normalized MCP results. Approval-required
responses contain an explicit `approvalId` and `executed: false`; M4 adds the
explicit status and exactly-once execution continuation described below.

Run the MCP-shaped M3 demonstration with:

```bash
npm run demo:mcp
```

Run the complete M1–M5 local lifecycle demonstration with:

```bash
npm run demo:mcp:e2e
```

The presentation sequence and expected evidence are documented in
[`docs/mcp-e2e-demo-guide.md`](docs/mcp-e2e-demo-guide.md). The POC completion
boundary is summarized in
[`docs/poc-completion-summary.md`](docs/poc-completion-summary.md).

Intentionally excluded from this POC are audit databases, dashboards, durable or production storage, complex audit-search APIs, immutable ledgers, production authentication, real MCP integration, external databases, and real external side effects. In-memory audit events and approvals disappear when the process exits.

Optional local settings are documented in `.env.example`. This POC does not load `.env` files automatically; provide values through the process environment if needed.

RBAC for MCP servers. Drop-in role-based access control for any MCP server — agents only see the tools their role permits.

Built for a venture studio that needed to give co-founders and partners agent-level access to a shared stack without building another admin dashboard. Their Claude session becomes a terminal into the shared venture, scoped to what they should actually be able to touch.

## Install

```
npm install @llvs/mcpack
```

MCPack pins `@modelcontextprotocol/server 2.0.0`, the official v2 SDK line that
supports MCP protocol `2026-07-28`.

## Quick Start

```typescript
import { mcpack } from '@llvs/mcpack';

// A public, stateless v2 McpHttpHandler from createMcpHandler(...)
const upstream = createMyMcpHandler();

const { handler, handle } = await mcpack(upstream, {
  roles: {
    cofounder: ['get_deals', 'update_deal_status', 'list_payments'],
    advisor:   ['get_deals'],
    admin:     ['*']
  },
  defaultRole: 'advisor'
});

// Mount handler.fetch in a Web Request/Response-compatible HTTP host.
```

That's it. Your server now enforces role-based access at both layers:

- **Discovery:** `tools/list` returns a single `search_tools` tool. Agents search by keyword and only see tools their role permits.
- **Execution:** `tools/call` is blocked for out-of-role tools — even if the agent somehow knows the name. The error is deliberately opaque: `"Unknown tool: {name}"`. Restricted tools are invisible, not just blocked.

## How It Works

**1. Agent connects.** `tools/list` returns one tool: `search_tools`. No schema dump.

**2. Agent searches.** Calls `search_tools` with a natural language query. MCPack returns matching schemas, filtered by role, ranked by relevance.

```json
{
  "name": "search_tools",
  "arguments": { "query": "deals and payments", "limit": 3 }
}
```

**3. Agent sees only what their role allows.**

A `cofounder` searching "deals and payments" sees `get_deals`, `update_deal_status`, `list_payments`. An `advisor` searching the same query sees only `get_deals`. An `admin` with `'*'` sees everything.

**4. Execution is enforced.** If an `advisor` tries to call `update_deal_status` directly, MCPack returns `"Unknown tool: update_deal_status"` — not "access denied", not "insufficient permissions". The tool doesn't exist as far as that agent knows.

## Two Modes

### Wrap Mode

Compose MCPack in front of an existing stateless MCP v2 HTTP handler. MCPack
discovers the upstream server through public MCP requests, then exposes a new
handler that adds RBAC and lazy discovery.

```typescript
import { mcpack } from '@llvs/mcpack';

const upstream = createMcpHandler(() => createMyServer(), {
  legacy: 'reject'
});

const { handler, handle } = await mcpack(upstream, {
  roles: {
    cofounder: ['get_deals', 'update_deal_status', 'list_payments'],
    advisor:   ['get_deals'],
    admin:     ['*']
  },
  defaultRole: 'advisor'
});
```

### Build Mode

Build a new MCP server from scratch with RBAC baked in from the start.

```typescript
import { createMCPackServer } from '@llvs/mcpack';

const { handler, handle } = createMCPackServer({
  name: 'venture-server',
  version: '1.0.0',
  roles: {
    cofounder: ['get_deals', 'update_deal_status', 'list_payments'],
    advisor:   ['get_deals'],
    admin:     ['*']
  },
  defaultRole: 'advisor',
  tools: [
    {
      name: 'get_deals',
      description: 'List all active deals in the pipeline',
      inputSchema: { type: 'object', properties: {} },
      handler: async (args, ctx) => {
        return { deals: await db.getDeals() };
      },
    },
    // ... more tools
  ],
});

// Mount handler.fetch in a Web Request/Response-compatible HTTP host.
// server/discover may be the first request; initialize is not used.
```

Both modes retain the same RBAC filtering and `search_tools` interface. Build
mode is stateless under MCP `2026-07-28`: every request carries protocol
metadata, and every search returns complete matching schemas. Wrap mode uses
the same request-scoped protocol boundary.

#### Build-mode compatibility change

Build mode no longer reads `extra.sessionId`, accepts `Mcp-Session-Id`, creates
a synthetic stdio session, or requires `initialize` / `notifications/initialized`.
`MCPackHandlerContext.sessionId` was replaced with request-scoped
`protocolVersion`, `clientCapabilities`, and optional self-reported `clientInfo`.
The latter is attribution only and never changes role or policy decisions.
Build-mode search responses no longer contain `session_id`.

Wrap mode also no longer mutates an SDK `Server` in place. The v2 SDK has no
public API for retrieving registered handlers, so `mcpack()` now composes over
a public `McpHttpHandler` and returns `{ handler, handle }`. This avoids the
former private `_requestHandlers` dependency. Wrap mode preserves the upstream
identity, merges its capabilities with MCPack's tools capability, forwards tool
calls through ordinary stateless MCP requests, and never uses clientInfo for
authorization.

### Explicit MCP approval continuation (M4)

Policy-gated MCP calls that require review return an explicit `approvalId`.
Clients may inspect it with `approvals.status` and, after the existing local
approval fixture approves it, execute it with `approvals.execute`. Both calls
take exactly `{ "approvalId": "approval-..." }`; they require no initialize,
session header, prior connection history, or reused JSON-RPC request ID.

The stored original requester, role, agent, tool, arguments, policy match, and
gateway correlation remain immutable. Request `clientInfo` is attribution only
and cannot replace that identity. Execution uses the repository's atomic claim,
so concurrent calls and retries cannot execute an approval twice. Normal MCP
results include `resultType`, server identity, and request/origin correlation.

The public `ToolCallRequest`, `RequestContext`, `Approval`, and `AuditEvent`
types now have an optional `mcpRequestId` correlation field. This is a
session-related compatibility change: integrations that serialize these values
may observe the new field, but it is optional and is never authorization data.

Approval expiry is intentionally not invented in M4 because the current local
approval model has no expiry state. Durable storage, expiry semantics, and the
full end-to-end MCP gateway conformance demonstration remain M5 work.

## Legacy Wrap-mode Session Tracking

This session-gated behavior is retained only in the legacy engine tests and is
not used by either MCP `2026-07-28` adapter. Build and wrap mode return complete
schemas deterministically on every request.

```json
{
  "tools": [
    { "name": "get_deals", "loaded": false, "schema": { "..." } },
    { "name": "list_payments", "loaded": true }
  ]
}
```

The JSON above documents the retired legacy representation. Modern build and
wrap responses always use `loaded: false` with the complete schema and omit
`session_id`.

## Token Reduction: A Side Effect Worth Measuring

RBAC is the primary value. But scoping what agents can see also dramatically cuts token usage — agents load only the schemas they need instead of the full tool surface.

Measured on Stripe MCP (28 tools). Real harness output:

```
=== MCPack Token Reduction Report ===

Stripe MCP tools discovered: 28

Query: "create a payment"
  Tools: 28 vanilla -> 5 MCPack
  Chars: 33258 -> 4158 (87.5% reduction)
  Est. tokens: 8315 -> 1040 (saved ~7275)

Query: "issue refund"
  Tools: 28 vanilla -> 3 MCPack
  Chars: 33258 -> 3196 (90.4% reduction)
  Est. tokens: 8315 -> 799 (saved ~7516)

--- Aggregate ---
Overall reduction: 80.7%
Total est. tokens saved: 33,560
```

| Query | Vanilla Tokens | MCPack Tokens | Reduction |
|-------|---------------|---------------|-----------|
| create a payment | 8,315 | 1,040 | 87.5% |
| manage customers | 8,315 | 1,984 | 76.1% |
| subscription billing | 8,315 | 3,279 | 60.6% |
| issue refund | 8,315 | 799 | 90.4% |
| list invoices | 8,315 | 913 | 89.0% |
| **Aggregate** | **41,575** | **8,015** | **80.7%** |

Results vary by server size and query breadth — larger tool surfaces see greater reduction.

Numbers represent character counts of serialized JSON payloads, not actual LLM tokens. Estimated tokens use chars/4 approximation.

## Roadmap

- **v1.0:** RBAC, keyword search, session tracking (this release)
- **v1.1:** Semantic search, tool usage analytics
- **v2.0:** Binary encoding layer

## Specification

See the [full specification](spec/mcpack-spec-v1.md) for protocol details, architecture, and configuration reference.

## License

MIT
