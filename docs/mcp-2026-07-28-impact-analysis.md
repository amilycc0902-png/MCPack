# MCP 2026-07-28 Impact Analysis

## Executive summary

The current repository contains two distinct surfaces:

1. the published MCPack library (`src/wrap.ts`, `src/build.ts`, and `src/core.ts`), which uses the MCP SDK and implements MCP `tools/list` and `tools/call`; and
2. the Policy Gateway POC (`src/app.ts` and the `src/http`, `src/gateway`, `src/policy`, `src/approval`, `src/tools`, and `src/audit` modules), which is a local Fastify JSON API and **does not currently implement MCP transport**.

The [official MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) makes MCP requests stateless, removes protocol sessions and initialization, requires per-request protocol metadata and typed results, and adds `server/discover`. These changes directly affect the library's MCP adapters and its session-gated discovery model. They do not prohibit the gateway from keeping application-level approval, policy, tool-registry, or audit state.

The key distinction is:

| State category | Meaning | Current examples | 2026-07-28 impact |
| --- | --- | --- | --- |
| **A. MCP protocol state** | Connection/session state implicitly established or recovered by the MCP protocol or transport. | SDK `extra.sessionId`; `Mcp-Session-Id`-style assumptions; schema delivery varying by session. | Must be removed from a 2026-07-28 MCP adapter. |
| **B. Application state outside MCP** | Business state owned by the gateway and addressed explicitly in ordinary request data. | Approval records addressed by `approvalId`; audit records; static policy snapshot; tool catalog. | Allowed. Cross-call workflow state should use explicit server-minted handles, with authorization and lifecycle controls. |
| **C. Local POC-only in-memory state** | Non-durable implementations used for local demonstration. | `InMemoryApprovalRepository`, execution-claim set, `InMemoryAuditSink`, in-process policy array and tool registry. | Allowed for the POC. It is unsuitable for restart recovery, multi-process deployment, or production exactly-once guarantees, but that is an application limitation rather than an MCP statelessness violation. |

No product code was changed as part of this analysis.

## Scope and sources

This analysis uses the official 2026-07-28 changelog as the protocol source of truth. It also reviews `AGENTS.md`, the Policy Gateway implementation plan, the original POC PRD, `package.json`, all files under `src/`, and all tests under `test/` and `tests/`.

`docs/PRD.pdf` is not present in the repository. The review therefore uses the original supplied PRD at `C:\Users\86153\Desktop\MCPack POC PRD.pdf`. This path discrepancy should be corrected separately as documentation housekeeping; it does not affect the protocol conclusions.

## Detailed change analysis

### 1. MCP is now stateless

| Question | Assessment |
| --- | --- |
| Current POC affected? | **Partly.** The Fastify Policy Gateway is not MCP and is not required to be stateless. The MCP library is affected because discovery behavior depends on connection/session state. |
| Exact source files affected | `src/core.ts`, `src/session.ts`, `src/types.ts`, `src/wrap.ts`, `src/build.ts`, `src/index.ts`; tests in `test/core.test.ts`, `test/session.test.ts`, `test/wrap.test.ts`, `test/build.test.ts`, and `test/tool-context-poc.test.ts`. |
| Current stateful assumption | `MCPackEngine` retains loaded schemas and query history in a `SessionRegistry`; later results differ based on earlier calls in the same `sessionId`. |
| Required code change | For a 2026-07-28 adapter, make each MCP response computable from request data plus server application state addressed by explicit arguments. Remove implicit per-connection schema-delivery behavior, or redesign it around a server-minted explicit discovery handle passed as a normal argument. Keep policy evaluation transport-neutral. |
| Timing | **Required only for real MCP integration**, but mandatory before claiming 2026-07-28 protocol compatibility for wrap/build mode. |
| Migration risk | **High.** Session-gated schema delivery is a core v1 behavior and token-reduction mechanism. Removing it changes response shape and caching behavior. |
| Tests to add/change | Replace session-dependent search tests with request-isolation tests; assert identical requests do not depend on prior connection calls; add explicit-handle tests if that design is retained; preserve RBAC and deterministic ordering tests. |

Stateless MCP does **not** mean the gateway process cannot retain approvals or audit events. It means MCP behavior cannot rely on an implicit protocol session or hidden connection history.

### 2. Protocol-level sessions and `Mcp-Session-Id` were removed

| Question | Assessment |
| --- | --- |
| Current POC affected? | The HTTP Policy Gateway does not read `Mcp-Session-Id`. The MCP library reads SDK `extra.sessionId` and propagates it through handlers. |
| Exact source files affected | `src/wrap.ts`, `src/build.ts`, `src/core.ts`, `src/session.ts`, `src/types.ts`; corresponding wrap/build/core/session tests. |
| Current stateful assumption | A transport or SDK supplies `extra.sessionId`; STDIO is assigned the synthetic `__stdio__` session. Roles, loaded tools, and query logs are then attached to that session. |
| Required code change | Stop reading `extra.sessionId` for protocol behavior; remove `sessionId` from public handler context or deprecate it as a non-protocol application field; remove `session_id` from search results; eliminate the synthetic STDIO session assumption. |
| Timing | **Required only for real MCP integration.** |
| Migration risk | **High** for existing consumers of `MCPackHandlerContext.sessionId`, `SearchToolResponse.session_id`, session options, and stats. This is a public API migration. |
| Tests to add/change | Assert no dependency on SDK session metadata; remove/replace TTL and sliding-session expectations; add backward-compatibility/type tests if old public fields receive a deprecation period. |

### 3. `initialize` and `notifications/initialized` were removed

| Question | Assessment |
| --- | --- |
| Current POC affected? | No direct handlers exist in repository code, but the installed SDK's `Server` abstraction may perform the older handshake at the transport layer. |
| Exact source files affected | Potentially `src/build.ts` and `src/wrap.ts`; dependency declarations in `package.json` and lockfile. The Fastify routes are unaffected. |
| Current stateful assumption | Repository code constructs an SDK `Server` with identity/capabilities and relies on the SDK lifecycle. It does not itself implement initialization. |
| Required code change | Upgrade to an SDK version that explicitly supports protocol 2026-07-28, then adapt server construction and transport wiring to its stateless API. Do not emulate the removed handshake in gateway code. |
| Timing | **Required only for real MCP integration.** |
| Migration risk | **Medium-high.** `wrap.ts` accesses private `_requestHandlers`, and both adapters use the deprecated low-level `Server`; an SDK upgrade can break these internals independently of the specification change. |
| Tests to add/change | Add protocol conformance tests proving a first request works without initialization and obsolete initialization is not required; exercise both STDIO and Streamable HTTP adapters when supported. |

`package.json` currently permits `@modelcontextprotocol/sdk` broadly as peer dependency `^1.0.0` and develops against `^1.27.1`. Neither declaration establishes 2026-07-28 support; compatibility must be pinned and tested against a supporting SDK release.

### 4. Every request carries protocol version, client capabilities, and preferably client identity in `_meta`

| Question | Assessment |
| --- | --- |
| Current POC affected? | The Fastify POC has its own request envelope and is not MCP. The MCP adapters currently do not validate or map the required `_meta` fields. |
| Exact source files affected | `src/wrap.ts`, `src/build.ts`, `src/types.ts`; future MCP-to-gateway adapter; tests in `test/wrap.test.ts`, `test/build.test.ts`, and `test/tool-context-poc.test.ts`. |
| Current stateful assumption | Protocol/version/capability negotiation is delegated to the SDK handshake. Policy identity comes from `defaultRole` or arbitrary tool arguments/observation context, not authenticated MCP client metadata. |
| Required code change | On every MCP request, accept and validate `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`; return `UnsupportedProtocolVersionError` for mismatch. Read `io.modelcontextprotocol/clientInfo` when present for attribution, but do **not** treat self-asserted client identity as authenticated user/role identity. Map verified external identity through a future adapter only. |
| Timing | **Required only for real MCP integration.** |
| Migration risk | **High** if client identity is mistakenly used for authorization. Protocol identity and business identity are separate trust domains. |
| Tests to add/change | Missing/unsupported version; missing capabilities; supported version; absent optional client info; client info preserved in audit attribution without granting roles; spoofed client info fails to elevate permissions. |

The existing Policy Gateway fields `userId`, `userRole`, and `agentId` remain explicitly untrusted fixture context under `AGENTS.md`. MCP `_meta.clientInfo` does not make them production-authenticated.

### 5. Servers return server identity in result `_meta`

| Question | Assessment |
| --- | --- |
| Current POC affected? | Only the real MCP surface. Fastify JSON responses are not MCP results. |
| Exact source files affected | `src/core.ts`, `src/build.ts`, `src/wrap.ts`, and result types in `src/types.ts`; all MCP result tests. |
| Current stateful assumption | Server identity is supplied once to the SDK constructor in build mode; wrapped-server identity is owned by the wrapped server. Results do not add `io.modelcontextprotocol/serverInfo`. |
| Required code change | Ensure every MCP success result includes result `_meta.io.modelcontextprotocol/serverInfo`, ideally through one response-normalization boundary. Wrap mode must preserve existing result metadata while adding/validating identity rather than overwriting it. |
| Timing | **Required only for real MCP integration.** |
| Migration risk | **Medium.** Centralized normalization is straightforward, but proxy results and errors require careful metadata merging. |
| Tests to add/change | Assert identity on tools list/search/call results; assert wrapped result `_meta` is preserved; test normalized primitive/custom handler results. |

### 6. `server/discover` is required

| Question | Assessment |
| --- | --- |
| Current POC affected? | The Fastify POC is unaffected. Neither MCP build nor wrap mode implements `server/discover`. |
| Exact source files affected | `src/build.ts`, `src/wrap.ts`, `src/types.ts`, `src/index.ts`; build/wrap tests. |
| Current stateful assumption | Capability and version discovery occurs during the old SDK initialization lifecycle. |
| Required code change | Register or expose `server/discover` advertising supported protocol versions, server capabilities, extensions, and identity. In wrap mode, safely compose with an existing discover handler. |
| Timing | **Required only for real MCP integration**, and blocking for a 2026-07-28-compliant server. |
| Migration risk | **Medium-high.** Private handler replacement makes composition fragile; the SDK may need a new public adapter mechanism. |
| Tests to add/change | Discover before any other request; exact supported versions/capabilities/identity; wrap-mode preservation/merge; unsupported-version behavior. |

### 7. Cross-call state uses explicit server-minted handles passed as ordinary tool arguments

| Question | Assessment |
| --- | --- |
| Current POC affected? | **Conceptually relevant, not prohibited.** `approvalId` is already server-minted and explicit, but today it is carried in custom HTTP paths rather than MCP tool arguments. Discovery state is implicit and must change. |
| Exact source files affected | Approval state: `src/approval/types.ts`, `src/approval/repository.ts`, `src/approval/approval-service.ts`, `src/http/approval-routes.ts`, `src/gateway/tool-call-service.ts`. Discovery state: `src/core.ts`, `src/session.ts`, `src/wrap.ts`, `src/build.ts`. Tests: approval workflow plus core/session/wrap/build. |
| Current stateful assumption | Approval lifecycle is addressed by `approvalId`; HTTP endpoints use it as a route parameter. Execution claims are in-memory. By contrast, loaded-schema state is keyed invisibly by session. |
| Required code change | Keep `approvalId` as an opaque server-minted application handle. For MCP exposure, pass it as an ordinary tool argument to explicit approval status/review/execute tools or an extension designed for the workflow. Bind the handle to original request, permitted reviewer, status, expiry, and tool digest; reject forged/unknown handles. Replace session-gated discovery with stateless responses or an explicit handle. |
| Timing | Approval internals: **not required now** for the local HTTP POC. MCP argument adapter: **required only for real MCP integration**. Session discovery migration: required before real integration. |
| Migration risk | **High** for exactly-once semantics in production. In-memory claims prevent duplicates only within one process lifetime; restart or multiple workers can re-execute. |
| Tests to add/change | Opaque/forged/missing handle; handle bound to request and actor; expiry; replay after success; concurrent execution; restart/multi-instance tests for a future durable repository; MCP argument-schema validation. |

`POST /v1/approvals/:id/approve` and `POST /v1/approvals/:id/execute` can remain as local administrative APIs. They are not MCP protocol calls and do not violate stateless MCP. A real MCP adapter should not depend on an HTTP connection session and should use the same transport-neutral `ApprovalService` behind explicit inputs.

### 8. All results require `resultType`

| Question | Assessment |
| --- | --- |
| Current POC affected? | MCP results are affected. Fastify responses are application JSON and need not add MCP `resultType` unless intentionally aligned with MCP result schemas. |
| Exact source files affected | `src/core.ts`, `src/build.ts` (`normalizeResult`), `src/wrap.ts` (proxied/error results), `src/types.ts`; core/build/wrap tests. |
| Current stateful assumption | Existing tool results return `content` and optional `isError`, with no `resultType`. Search/list results also omit it. |
| Required code change | Add `resultType: "complete"` to all ordinary MCP results, including errors represented as tool results. Preserve `input_required` if future upstream results use MRTR. Do not blindly overwrite a wrapped result. |
| Timing | **Required only for real MCP integration.** |
| Migration risk | **Medium.** Central normalization can cover build mode; wrap mode and every early return must be audited. |
| Tests to add/change | Assert `resultType` on list/search/call success, opaque denial, validation error, missing handler, and execution failure; assert upstream `input_required` is preserved. |

### 9. Streamable HTTP POST headers include `Mcp-Method` and `Mcp-Name`

| Question | Assessment |
| --- | --- |
| Current POC affected? | No current route is an MCP Streamable HTTP endpoint. `/v1/tools/call` and approval routes are custom Fastify APIs. |
| Exact source files affected | No existing file is directly noncompliant. A future MCP transport adapter would be new; `src/app.ts` should remain separate. `package.json` SDK version may need updating. |
| Current stateful assumption | None. Existing routes infer operation from HTTP method/path and do not accept MCP headers. |
| Required code change | In a future Streamable HTTP adapter, require and validate `Mcp-Method` and `Mcp-Name` against the JSON-RPC body, returning the specified header mismatch error. Do not retrofit these headers onto the custom approval REST API. |
| Timing | **Required only for real MCP Streamable HTTP integration.** |
| Migration risk | **Medium**, mainly proxy/header canonicalization and mismatch handling. |
| Tests to add/change | Missing headers, method/name mismatch, valid tool call, non-tool MCP method, case handling, and no accidental requirement on local `/v1` routes. |

### 10. SSE resumability and message redelivery were removed

| Question | Assessment |
| --- | --- |
| Current POC affected? | No. The repository does not implement SSE, `Last-Event-ID`, or MCP message redelivery. |
| Exact source files affected | None currently. A future transport adapter and request-id/idempotency layer would be affected. |
| Current stateful assumption | `requestId` is caller-supplied and used for correlation, but it is not tied to SSE events. Approval execution uses a separate server-generated `approvalId`. |
| Required code change | Do not implement SSE replay. On a broken request stream, the client must retry with a new MCP JSON-RPC request ID. Preserve application workflow correlation separately. Decide whether application `requestId` must be unique and idempotent rather than assuming transport redelivery. |
| Timing | **Not relevant to the current POC**; required only when adding Streamable HTTP. |
| Migration risk | **Medium-high** for side-effecting tools. A new transport request ID does not by itself prevent duplicate business execution. Approval/tool execution needs an application idempotency key or durable execution record. |
| Tests to add/change | New transport request ID after interruption; same application handle/idempotency key does not double execute; distinguish MCP request ID from gateway `requestId` and `approvalId`. |

The current `requestId` lifecycle is under-specified: the client supplies it, duplicates are not rejected, and it is used as an audit correlation value rather than an execution lock. It must not be treated as proof that a retried MCP request is safe.

### 11. `subscriptions/listen` replaces the previous HTTP GET and subscription model

| Question | Assessment |
| --- | --- |
| Current POC affected? | No current MCP subscriptions exist. Fastify `GET /health` and `GET /v1/approvals/:id` are ordinary application endpoints, not the removed MCP transport GET endpoint. |
| Exact source files affected | None now. A future MCP transport/subscription adapter may integrate with tool-list or approval-change events. |
| Current stateful assumption | Clients poll approval status through REST; the MCP library exposes no resource subscription handlers. |
| Required code change | None for the POC. If server-to-client change notifications are added, use a long-lived POST-response `subscriptions/listen` stream, explicit requested notification types, and returned subscription IDs. Approval polling may remain an application API. |
| Timing | **Not relevant to this POC.** Required only if future MCP subscription capability is advertised. |
| Migration risk | **Low** because no old implementation must be removed. |
| Tests to add/change | Only when implemented: capability advertisement, listen acknowledgement, subscription ID tagging, selected event types, disconnect behavior, and separation from request-scoped notifications. |

### 12. Logging is deprecated; OpenTelemetry is preferred

| Question | Assessment |
| --- | --- |
| Current POC affected? | MCP protocol logging is not implemented. The `AuditSink` is business/security evidence, not MCP Logging, and should not be removed. |
| Exact source files affected | `src/audit/types.ts`, `src/audit/audit-service.ts`, `src/audit/in-memory-audit-sink.ts`, `src/app.ts`; console usage in `src/demo/audit-demo.ts`, `src/wrap.ts`, and `src/build.ts`; `package.json` only if an OpenTelemetry adapter is later added. |
| Current stateful assumption | `InMemoryAuditSink` retains sanitized events for the local process. The demo prints them. Wrap/build emit a few `console.warn` diagnostics. No `logging/setLevel` or `notifications/message` implementation exists. |
| Required code change | No immediate audit change. Keep `AuditSink` replaceable and distinguish audit evidence from diagnostics/telemetry. For production MCP integration, propagate standard OpenTelemetry trace context from `_meta` and provide an optional telemetry adapter; do not add new MCP Logging support. Preserve audit fail-closed semantics independently of telemetry sampling/failure. |
| Timing | Audit sink: **does not need to change now**. OpenTelemetry: **can wait** until real MCP/production integration. |
| Migration risk | **Low-medium.** The main risk is conflating lossy telemetry with mandatory audit delivery. Zaid's sink should remain authoritative for audit events. |
| Tests to add/change | Trace-context propagation without logging sensitive baggage; audit events still emitted when telemetry is disabled; telemetry failure policy explicitly separate from audit-sink failure; no MCP logging notifications. |

## Component-by-component impact

| Component | Current role | Impact and recommendation |
| --- | --- | --- |
| `InMemoryApprovalRepository` | Stores pending/reviewed/executed approvals and in-process execution claims. | Valid local application state. Keep for POC. Before production/multi-process use, replace through the repository boundary with durable atomic compare-and-set semantics. |
| `approvalId` | Server-generated opaque handle linking approval operations to stored request context. | Correct direction under stateless MCP. For MCP, pass as an ordinary argument, validate authorization on every operation, add expiry and durable replay protection. |
| `POST /v1/approvals/:id/approve` | Local fixture-review endpoint. | Not an MCP endpoint; may remain. Reviewer role is untrusted POC context and must not be presented as production authorization. |
| `POST /v1/approvals/:id/execute` | Claims an approved record and executes once per process. | Not prohibited. For real deployment, require durable exactly-once/idempotency safeguards. For MCP exposure, wrap behind an explicit tool/extension input rather than a session. |
| `requestId` | Caller-provided correlation value copied into decisions, approvals, and audit. | Keep separate from MCP JSON-RPC request ID. Define uniqueness/idempotency semantics before real side effects; never rely on SSE redelivery. |
| `InMemoryAuditSink` | Sanitized local audit event collector. | Valid POC application state and already replaceable through `AuditSink`. It is not MCP Logging. No protocol-driven removal is needed. |
| Sample policy array | Static deterministic policy snapshot. | Protocol-neutral and stateless with respect to calls. No MCP change required. A validated loader/durable administration system remains a V1/application concern. |
| `ToolRegistry` | Deterministic in-process mock dispatch map. | Protocol-neutral. Keep it; introduce an MCP executor adapter behind the same boundary later. Ensure MCP tool schemas/results meet the new specification. |
| Fastify `/v1` routes | Local demo/control API. | Not MCP transport. Do not retrofit MCP headers, `_meta`, `server/discover`, or `resultType` onto these routes unless intentionally replacing them with an MCP endpoint. |
| `SessionRegistry` | Per-session loaded-schema cache and query history. | Directly incompatible with stateless MCP when used to vary protocol responses by connection/session. Retire or redesign around ordinary explicit handles/application analytics. |
| `MCPackEngine` | Search, role filtering, and session-aware schema delivery. | Search and role filtering remain useful. Session-dependent schema suppression and `session_id` response fields require migration. |
| `wrap.ts` / `build.ts` | Actual MCP handler adapters. | Primary migration surface: new SDK, no handshake/session assumptions, request/result `_meta`, `server/discover`, `resultType`, and transport conformance. |

## Required changes before real MCP integration

1. Select and pin an MCP SDK release that explicitly supports protocol `2026-07-28`; verify whether a public interception/composition API can replace private `_requestHandlers` access.
2. Remove protocol-session dependence from `wrap.ts`, `build.ts`, `core.ts`, public types, and search responses. Decide whether repeated-schema suppression is removed or redesigned with an explicit server-minted ordinary argument.
3. Implement `server/discover` and per-request version/capability validation, including unsupported-version errors.
4. Consume request `_meta` and attach server identity to every result `_meta` without treating client self-identification as authenticated business identity.
5. Add `resultType` to every MCP result and preserve `input_required` results from upstream handlers.
6. For Streamable HTTP, validate `Mcp-Method` and `Mcp-Name`; do not implement removed `Mcp-Session-Id`, GET transport, SSE replay, or old subscription behavior.
7. Define three separate identifiers: MCP JSON-RPC request ID, gateway workflow/tool-call correlation ID, and server-minted approval/idempotency handle.
8. Expose approvals through explicit arguments if they are made available over MCP, while retaining authorization checks and repository-backed atomic state transitions.
9. Add conformance tests for stateless first-call operation, discovery, metadata, result typing, headers, and retry/idempotency behavior.

## Changes that can wait

- Durable approval and audit storage can wait for production deployment; in-memory implementations remain valid for the local POC.
- OpenTelemetry instrumentation can wait until a real MCP transport/operability phase, provided MCP Logging is not newly adopted.
- `subscriptions/listen` can wait until the server advertises subscription-related capabilities.
- Production identity verification, external policy administration, A2A, SQL analysis, dashboards, and external databases remain outside the POC under `AGENTS.md`.
- The local Fastify API does not need MCP-specific request headers, `_meta`, `server/discover`, or MCP result schemas.

## Components that do not need to change

- The pure deterministic policy evaluator and its default-deny/priority behavior.
- Sample policy storage for the local POC.
- The mock `ToolRegistry` abstraction and deterministic tool implementations.
- The `AuditSink` interface, sanitized event model, and fail-closed audit boundary.
- The approval state machine as a transport-neutral application service, subject to future durable storage and authenticated reviewer adapters.
- Zod validation on the custom HTTP request and approval routes.
- The intentional absence of A2A, SQL safety, real external side effects, and production authentication.

## Recommended migration sequence

1. **Freeze compatibility expectations.** Add characterization tests for current lazy discovery and public session-related types, then define the intended breaking-version policy.
2. **Upgrade the MCP SDK in isolation.** Prove a minimal 2026-07-28 server can handle a first request without initialization and can answer `server/discover`.
3. **Create a thin 2026-07-28 MCP adapter.** Keep policy, approval, execution, redaction, and audit services transport-neutral; place `_meta`, header, and `resultType` logic only in the adapter.
4. **Remove implicit sessions.** Make list/search deterministic per request. If schema-reuse state is still valuable, introduce an opaque server-minted handle as an ordinary argument with expiry and safe fallback.
5. **Normalize all MCP results.** Merge server identity metadata, add `resultType`, and preserve upstream metadata and MRTR results.
6. **Map identity conservatively.** Capture client identity for attribution only. Add a separate trusted resolver later; retain default deny when business identity cannot be verified.
7. **Adapt approval workflows.** Reuse `ApprovalService`; expose opaque handles through explicit inputs and separate MCP request IDs from workflow/idempotency identifiers.
8. **Add transport conformance and retry tests.** Cover headers, version mismatch, stream interruption, new request IDs, and duplicate-side-effect prevention.
9. **Add OpenTelemetry last.** Treat it as diagnostics/tracing, not a replacement for Zaid's mandatory audit sink.

## Concise message for Zaid

> MCP 2026-07-28 does not ban gateway application state. Our approval records and audit events can remain server-side because callers address approvals with an explicit server-minted `approvalId`; for real MCP we should pass that handle as an ordinary argument and back it with durable atomic storage. The real migration issue is MCPack's legacy `sessionId`-based schema delivery: protocol sessions and initialization are gone. Before integrating real MCP, we need a supporting SDK, stateless discovery plus `server/discover`, per-request/client `_meta`, server identity in result `_meta`, required `resultType`, and Streamable HTTP header conformance. The Policy Gateway's deterministic evaluator, tool registry, approval service boundary, and replaceable AuditSink can stay largely unchanged.

## Overall conclusion

The Policy Gateway POC itself is mostly insulated from the 2026-07-28 changes because it is currently a local application API, not an MCP transport implementation. The existing MCPack wrap/build library is not yet demonstrably compliant with the new version and has one fundamental mismatch: implicit session-dependent discovery. The safest architecture is to preserve explicit application state behind transport-neutral services while replacing protocol-session assumptions with per-request metadata and explicit server-minted handles.
