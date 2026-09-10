# MCP 2026-07-28 Migration Plan

## Purpose

This plan defines the smallest migration needed for MCPack to support MCP protocol version `2026-07-28`. It is based on `docs/mcp-2026-07-28-impact-analysis.md` and the current source and test suites.

The repository currently has two separate surfaces:

- the existing MCPack library in `src/build.ts`, `src/wrap.ts`, and `src/core.ts`, which implements MCP handlers; and
- the Policy Gateway POC in `src/gateway`, `src/policy`, `src/approval`, `src/audit`, `src/tools`, and `src/http`, which is transport-neutral application logic exposed through a custom Fastify API.

The migration should preserve this boundary. MCP protocol behavior belongs in thin adapters. Policy evaluation, approvals, execution, output redaction, and audit handling must remain independent of MCP transport.

## Migration principles

1. Do not treat MCP statelessness as a ban on application state.
2. Remove implicit protocol-session state from MCP responses.
3. Pass cross-call application state through explicit server-minted handles in ordinary arguments.
4. Keep MCP client identity metadata separate from authenticated business identity. All current POC identity remains untrusted fixture context.
5. Migrate build mode before wrap mode because build mode owns its server and does not depend on replacing private SDK handlers.
6. Do not add production authentication, external storage, A2A, SQL analysis, dashboards, or real side effects.

## 1. Changes required in the existing MCPack library

### L1. Select and pin a 2026-07-28-capable MCP SDK

| Item | Plan |
| --- | --- |
| Exact files affected | `package.json`, `package-lock.json`; possibly import sites in `src/build.ts`, `src/wrap.ts`, and `src/types.ts`; SDK-facing tests in `test/build.test.ts` and `test/wrap.test.ts`. |
| Implementation steps | Identify the first SDK release that explicitly implements `2026-07-28`; raise both the peer dependency floor and development dependency to that compatible line; adapt imports and schemas only as required; document the supported protocol version and any peer-dependency break in `README.md`. |
| Tests required | Dependency installation; TypeScript build; existing MCP test suite; a version-capability smoke test proving the selected SDK exposes the required request/result schemas. |
| Breaking-change risk | **High.** The current peer range starts at `^1.0.0`, and code uses the deprecated low-level `Server` plus private `_requestHandlers`. |
| Estimated complexity | **Medium** if compatible SDK APIs exist; **large** if handler interception requires redesign. |

This dependency update should not be guessed. The implementation phase must verify SDK support before changing the peer range.

### L2. Add a centralized MCP 2026 protocol boundary

| Item | Plan |
| --- | --- |
| Exact files affected | New `src/mcp/protocol.ts` and `src/mcp/result.ts`; `src/build.ts`, `src/wrap.ts`, `src/types.ts`, `src/index.ts`; new `test/mcp-protocol.test.ts`. |
| Implementation steps | Define the supported protocol constant; validate required request `_meta` fields for protocol version and client capabilities; preserve optional client information for attribution only; create one result-normalization helper that merges existing `_meta`, adds server identity, and adds `resultType: "complete"` unless an upstream `resultType` is already present. Map unsupported versions to the SDK's specified error. |
| Tests required | Supported and unsupported version; missing required metadata; optional client info; metadata preservation; server identity merge; ordinary results get `complete`; upstream `input_required` remains unchanged. |
| Breaking-change risk | **Medium.** Result shapes gain required fields, but centralization reduces inconsistent behavior. |
| Estimated complexity | **Medium**. |

The protocol helper must not resolve business roles from `clientInfo`. Authorization remains outside this boundary.

### L3. Implement `server/discover`

| Item | Plan |
| --- | --- |
| Exact files affected | `src/build.ts`, `src/wrap.ts`, `src/types.ts`; protocol helper from L2; `test/build.test.ts`, `test/wrap.test.ts`, and possibly new `test/server-discover.test.ts`. |
| Implementation steps | Register `server/discover` in build mode; return supported protocol versions, capabilities, extensions, and server identity; allow it as the first request; in wrap mode, preserve or safely compose with an upstream discover handler rather than silently replacing incompatible information. |
| Tests required | Discovery before any other call; exact version/capability/identity response; required `resultType` and server `_meta`; wrap-mode composition; unsupported-version handling. |
| Breaking-change risk | **Medium-high** in wrap mode because current interception relies on a private handler map. |
| Estimated complexity | **Small** for build mode; **medium-large** for safe wrap-mode composition. |

### L4. Remove implicit MCP session dependence from lazy discovery

| Item | Plan |
| --- | --- |
| Exact files affected | `src/core.ts`, `src/session.ts`, `src/types.ts`, `src/index.ts`, `src/build.ts`, `src/wrap.ts`; `test/core.test.ts`, `test/session.test.ts`, `test/build.test.ts`, `test/wrap.test.ts`, `test/tool-context-poc.test.ts`. |
| Implementation steps | Stop reading SDK `extra.sessionId`; remove the synthetic `__stdio__` session; make `search_tools` results depend only on the current request, configured tools, and role policy; return complete matched schemas deterministically on each request; remove `session_id` from search responses; remove or deprecate public `session` configuration, `sessionId` handler context, and session-count stats. Delete `SessionRegistry` only after no production import remains. |
| Tests required | Identical requests produce equivalent results regardless of call order or connection; no session metadata is read; repeated searches remain valid; deterministic ordering; role filtering and opaque denial remain intact; public type migration tests if deprecated fields are temporarily retained. |
| Breaking-change risk | **High.** Session-gated schema suppression is a documented v1 behavior and public response/type surface. |
| Estimated complexity | **Large**. |

The smallest compliant behavior is to return matching schemas on every search. An explicit discovery-cache handle could preserve more token savings, but it is optional and should not be part of the first migration phase.

### L5. Normalize every MCP result

| Item | Plan |
| --- | --- |
| Exact files affected | `src/core.ts`, `src/build.ts`, `src/wrap.ts`, `src/types.ts`; result helper from L2; `test/core.test.ts`, `test/build.test.ts`, `test/wrap.test.ts`. |
| Implementation steps | Route list, search, call, opaque-denial, missing-handler, validation-error, and execution-failure results through the common normalizer; add `resultType`; add server identity in result `_meta`; preserve upstream result metadata and `input_required`; avoid leaking internal errors while changing shapes. |
| Tests required | Every success and early-error branch; proxy result metadata preservation; primitive build-handler normalization; upstream `input_required`; unchanged opaque-denial semantics. |
| Breaking-change risk | **Medium.** Wire result shapes change, but the old shapes are no longer compliant. |
| Estimated complexity | **Medium**. |

### L6. Update handler context and public API types

| Item | Plan |
| --- | --- |
| Exact files affected | `src/types.ts`, `src/index.ts`, `src/build.ts`, `src/wrap.ts`; tests using `MCPackHandlerContext`, especially `test/build.test.ts` and `test/tool-context-poc.test.ts`; `README.md` and relevant docs. |
| Implementation steps | Replace protocol-derived `sessionId` with a request-scoped MCP context containing protocol version, client capabilities, and optional untrusted client info; mark the compatibility break clearly; keep tool name, arguments, and transport-neutral observation fields; do not introduce authenticated identity claims. |
| Tests required | Handler receives current request metadata; no context survives implicitly to a later request; absent optional client info; existing callback ordering and failure handling. |
| Breaking-change risk | **High** because exported TypeScript interfaces change. This likely warrants a new major library version unless a deprecation bridge is retained. |
| Estimated complexity | **Medium**. |

### L7. Add Streamable HTTP conformance only if MCPack owns that transport

| Item | Plan |
| --- | --- |
| Exact files affected | Prefer a new `src/mcp/streamable-http.ts`; `src/index.ts`, `package.json`; new `test/streamable-http.test.ts`. Existing `src/app.ts` and `/v1` routes should not be repurposed. |
| Implementation steps | Require and validate `Mcp-Method` and `Mcp-Name`; reject header/body mismatch with the specified error; do not accept `Mcp-Session-Id`; do not implement HTTP GET transport, `Last-Event-ID`, event replay, or SSE resumability. Delegate JSON-RPC handling to the compatible SDK where possible. |
| Tests required | Required/missing/mismatched headers; valid method/name; no session header dependence; interrupted request is retried using a new protocol request ID; custom Fastify POC routes remain unaffected. |
| Breaking-change risk | **Low** if this is a new opt-in adapter; **high** if replacing a transport exposed elsewhere. |
| Estimated complexity | **Large**. |

This is not required if MCPack continues to provide only server wrapping/building and delegates transport ownership entirely to the host application and SDK.

## 2. Changes required for the Policy Gateway MCP adapter

The Policy Gateway currently has no MCP adapter. The smallest integration should add one adapter that translates MCP calls into existing transport-neutral services. It should not rewrite the Fastify API or duplicate policy logic.

### G1. Define an MCP-to-gateway request mapper

| Item | Plan |
| --- | --- |
| Exact files affected | New `src/mcp/policy-gateway-adapter.ts` and `src/mcp/types.ts`; existing `src/gateway/types.ts`, `src/policy/types.ts`, and `src/index.ts`; new `tests/mcp/policy-gateway-adapter.test.ts`. |
| Implementation steps | Convert MCP `tools/call` name/arguments and request `_meta` into the existing gateway request contract; mint or map a gateway correlation ID independently of the MCP JSON-RPC request ID; carry client info only as untrusted attribution; inject `ToolCallService` rather than importing HTTP routes; fail closed when required policy context cannot be constructed. |
| Tests required | Valid mapping; missing protocol metadata; unsupported version; missing fixture identity context; spoofed client info does not grant a role; distinct MCP and gateway request IDs; policy evaluation occurs before execution. |
| Breaking-change risk | **Low** if added as a new adapter. |
| Estimated complexity | **Medium**. |

For the local POC, fixture `userId`, `userRole`, and `agentId` may be supplied through a clearly documented adapter-specific test context. They must remain explicitly untrusted and must not be inferred as authenticated from MCP client identity.

### G2. Map gateway outcomes to compliant MCP results

| Item | Plan |
| --- | --- |
| Exact files affected | New adapter/result mapping files under `src/mcp`; `src/gateway/types.ts` only if a transport-neutral result discriminator is needed; new MCP adapter tests. |
| Implementation steps | Map allow to an MCP `complete` result; preserve opaque denial without exposing hidden-tool details; map validation/internal failures safely; map approval-required to a `complete` application result containing an explicit `approvalId` unless a standards-based `input_required` flow is deliberately selected later; attach server identity `_meta`. |
| Tests required | Allow, deny, unknown tool, invalid arguments, approval required, audit failure, execution failure; every result has `resultType` and server identity; no sensitive error leakage. |
| Breaking-change risk | **Low** for existing REST consumers; **medium** for deciding the external MCP result contract. |
| Estimated complexity | **Medium**. |

Using `complete` plus an explicit approval handle is the smallest approach. It avoids adding MRTR behavior to the POC and keeps approval asynchronous.

### G3. Expose approval continuation through explicit handles

| Item | Plan |
| --- | --- |
| Exact files affected | New adapter tool definitions under `src/mcp`; `src/approval/approval-service.ts`, `src/approval/types.ts`, and `src/gateway/types.ts` only if transport-neutral methods need refinement; `src/tools/registry.ts` must not own approval operations; new `tests/mcp/approval-handles.test.ts`; existing `tests/approval/approval-workflow.test.ts` remains authoritative for state transitions. |
| Implementation steps | Expose the minimum explicit operations needed to read status and execute an already approved request, each accepting `approvalId` as an ordinary argument; keep human approve/reject on the existing local HTTP API for the POC; validate handle format and existence; reuse `ApprovalService`; do not store state in an MCP connection; return the original tool result only after approved exactly-once execution. |
| Tests required | Missing/forged handle; pending/rejected/executed states; approved execution; sequential and concurrent duplicate execution; handle cannot select a different tool/request; MCP request retry with a new JSON-RPC ID cannot execute twice. |
| Breaking-change risk | **Low** as a new adapter, but the public approval-tool contract must be stable once released. |
| Estimated complexity | **Medium**. |

The existing `POST /v1/approvals/:id/approve`, reject, and execute routes can remain for the local demo. They are application APIs, not prohibited protocol session operations.

### G4. Adapt real MCP tool execution behind `ToolExecutor`

| Item | Plan |
| --- | --- |
| Exact files affected | New `src/mcp/mcp-tool-executor.ts`; existing `src/tools/registry.ts` or a new shared executor interface module; `src/gateway/tool-call-service.ts` should require no protocol knowledge; new executor tests and MCP adapter integration tests. |
| Implementation steps | Implement `ToolExecutor` using the wrapped/built MCP handler boundary; validate tool arguments before dispatch; never execute on deny or pending approval; preserve upstream `input_required`; pass results back through the gateway's eventual redaction boundary and MCP result normalizer. Keep mock tools as the default POC executor. |
| Tests required | Allow reaches upstream once; deny/approval do not; unknown tool never dispatches; upstream failure is sanitized; `input_required` preserved; call order policy-before-execution; audit failure remains fail closed. |
| Breaking-change risk | **Medium-high** because this unifies two currently separate execution paths. |
| Estimated complexity | **Large**. |

### G5. Keep approval and audit state application-scoped

| Item | Plan |
| --- | --- |
| Exact files affected | No required POC changes to `src/approval/repository.ts` or `src/audit/in-memory-audit-sink.ts`; adapter tests should use them. Documentation updates in `README.md`. |
| Implementation steps | Inject repositories and sinks into the adapter composition root; never key them by MCP session; document restart loss; preserve server-minted `approvalId`; keep audit and approval lifecycle correlation separate from MCP request IDs. |
| Tests required | State survives multiple independent MCP requests in one process using explicit handles; no connection/session prerequisite; restart-loss behavior may be documented rather than tested for the POC; audit attribution contains gateway request and approval IDs without sensitive data. |
| Breaking-change risk | **Low**. |
| Estimated complexity | **Small**. |

### G6. Add one end-to-end MCP adapter demonstration

| Item | Plan |
| --- | --- |
| Exact files affected | New MCP demo under `src/demo` or `test/harness`; `package.json`; `README.md`; new `tests/mcp/mcp-gateway-e2e.test.ts`. |
| Implementation steps | Demonstrate `server/discover`; make an allowed ticket search; make a denied refund; create an approval for a billing refund; approve through the existing fixture HTTP endpoint or direct test fixture; execute by passing `approvalId` explicitly in a new MCP request; print sanitized audit events. No real external side effects. |
| Tests required | Full allow, deny, approval, approve, execute, duplicate-execute, result metadata, and audit sequence assertions. |
| Breaking-change risk | **Low**. |
| Estimated complexity | **Medium** after L1-L6 and G1-G5 exist. |

## 3. Changes that can wait

### W1. Explicit handle for discovery-schema caching

| Item | Plan |
| --- | --- |
| Exact files affected | Future additions around `src/core.ts`, `src/types.ts`, and MCP adapter types/tests. |
| Implementation steps | Only if measurements justify it, mint an opaque cache/discovery handle and accept it as an ordinary `search_tools` argument; bind it to policy/tool-catalog versions and expiry; always fall back safely to complete schemas. |
| Tests required | Forged/expired/stale handle; role/policy binding; cache fallback; deterministic results. |
| Breaking-change risk | **Medium**. |
| Estimated complexity | **Large**. |

The first compliant version should simply return schemas per request.

### W2. Streamable HTTP transport owned by MCPack

This can wait if transport remains the host application's responsibility. If later added, use L7 and do not modify the custom `/v1` API into an MCP endpoint.

- Exact files: future `src/mcp/streamable-http.ts`, transport tests, exports, dependencies, and documentation.
- Tests: required headers, no GET transport, no session header, no SSE replay, disconnect/retry behavior.
- Breaking-change risk: **low** as opt-in.
- Complexity: **large**.

### W3. `subscriptions/listen`

No current MCP subscription model exists, so this is unnecessary until MCPack advertises list-change or resource-subscription capabilities.

- Exact files: future subscription adapter and tests; possibly `src/mcp/protocol.ts` capability advertisement.
- Tests: selected notification types, subscription IDs, disconnect behavior, request-scoped notification separation.
- Breaking-change risk: **low**.
- Complexity: **large**.

### W4. OpenTelemetry integration

Keep `AuditSink` separate from telemetry. Zaid's audit implementation must remain replaceable and may be fail-closed; OpenTelemetry diagnostics are a different concern.

- Exact files: future telemetry adapter; MCP request boundary for trace-context propagation; optional `package.json` dependency; tests.
- Tests: `traceparent`/`tracestate`/`baggage` propagation, sensitive-data filtering, telemetry disabled/failure behavior, audit independence.
- Breaking-change risk: **low**.
- Complexity: **medium**.

### W5. Durable storage and production idempotency

External databases are excluded from the POC. Before production or multi-process execution, replace in-memory approval claims with durable atomic transitions and choose production audit storage.

- Exact files: implementations behind `src/approval/repository.ts` and `src/audit/types.ts`; composition and deployment configuration.
- Tests: restart recovery, competing workers, durable exactly-once/idempotency behavior, retention and failure recovery.
- Breaking-change risk: **low** if interfaces remain stable.
- Complexity: **large**.

### W6. Production identity verification

MCP client information is attribution metadata, not authorization. Production authentication and role resolution remain excluded.

- Exact files: future identity resolver and adapter composition; no current source must change now.
- Tests: verified principal mapping, issuer/audience validation, spoof resistance, default deny.
- Breaking-change risk: **medium** for request contracts.
- Complexity: **large**.

### W7. MRTR and task extensions

The POC can return a completed application result containing `approvalId`; it does not need `input_required` or the tasks extension for asynchronous human approval.

- Exact files: future MCP adapter result mapping and extension capability declaration.
- Tests: retry/input response correlation and extension negotiation.
- Breaking-change risk: **medium**.
- Complexity: **large**.

## Recommended smallest first coding phase

### Phase M1 - Stateless build-mode compatibility slice

This is the smallest independently demonstrable phase. It proves the new protocol contract without simultaneously solving wrap-mode interception, Streamable HTTP, or Policy Gateway integration.

#### Scope

1. Verify and pin a 2026-07-28-capable MCP SDK.
2. Add the centralized protocol/result helpers from L2.
3. Implement `server/discover` in **build mode only**.
4. Remove build-mode dependence on `extra.sessionId`.
5. Make `search_tools` return deterministic complete schemas on every request.
6. Add `resultType` and server identity `_meta` to every build-mode result.
7. Update the public types needed by build mode, with an explicit compatibility decision for session fields.
8. Add focused build-mode conformance tests and update README usage notes.

#### Exact files expected

- `package.json`
- `package-lock.json`
- `src/build.ts`
- `src/core.ts`
- `src/types.ts`
- `src/index.ts`
- new `src/mcp/protocol.ts`
- new `src/mcp/result.ts`
- `test/build.test.ts`
- `test/core.test.ts`
- new `test/mcp-protocol.test.ts`
- `README.md`

`src/session.ts`, wrap mode, Fastify routes, policy evaluation, approvals, audit, and mock tools should not be changed in this first slice unless compilation requires a narrowly scoped compatibility adjustment.

#### Independent demonstration

Using an in-memory or STDIO test transport:

1. Call `server/discover` as the first request and show version, capabilities, and server identity.
2. Call `tools/list` with required request `_meta`.
3. Call `search_tools` twice without initialization or a session ID.
4. Show that both calls are valid and do not depend on hidden connection history.
5. Show `resultType: "complete"` and server identity in each result `_meta`.
6. Send an unsupported protocol version and show the specified error.

#### Tests and validation

- New protocol metadata and discovery tests.
- Updated build/core tests for stateless search.
- Existing search, index, role, and Policy Gateway suites unchanged and passing.
- Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.

#### Risk and complexity

- Breaking-change risk: **high**, because session-aware public behavior changes.
- Estimated complexity: **medium-large**.
- Risk control: limit the phase to build mode, keep a characterization test for old wrap mode, and do not publish until the public type/versioning decision is explicit.

## Subsequent sequence

1. **M1:** stateless build-mode compatibility slice.
2. **M2:** migrate wrap mode and remove private/session-dependent assumptions.
3. **M3:** add the MCP-to-Policy-Gateway mapper and compliant outcome mapping.
4. **M4:** expose explicit approval continuation handles and real MCP execution behind `ToolExecutor`.
5. **M5:** add the full local MCP gateway demonstration and conformance suite.
6. **Later:** optional Streamable HTTP ownership, subscriptions, OpenTelemetry, durable storage, and production identity.

## Completion criteria for minimum MCP 2026-07-28 support

Minimum support is complete when:

- a supported SDK version is pinned and documented;
- a server can answer `server/discover` before any other request;
- no MCP result varies based on an implicit protocol session;
- every request validates required protocol metadata;
- every ordinary result has `resultType: "complete"` and server identity `_meta`;
- unsupported versions fail with the specified protocol error;
- wrap and build modes either both comply or the package clearly exports only the compliant mode for the new major version;
- the complete existing non-MCP Policy Gateway test suite still passes; and
- no production-only or excluded feature has been introduced.
