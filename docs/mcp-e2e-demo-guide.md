# MCP 2026 Policy Gateway E2E Demo Guide

## Purpose

This 5–10 minute local demonstration proves the complete MCPack Policy Gateway
POC lifecycle using MCP protocol `2026-07-28`. It uses deterministic policies,
fixture identities, simulated tools, in-memory approvals, and in-memory audit
events. It performs no real external side effects.

## Architecture

```text
MCP request + required per-request metadata
  -> MCP 2026 protocol boundary
  -> MCP-to-Policy-Gateway adapter
  -> deterministic policy evaluator
  -> allow | opaque deny | explicit approvalId
  -> simulated ToolExecutor
  -> normalized MCP result + sanitized audit events
```

Approval state is application state addressed by an explicit `approvalId`. It
is not an MCP session and is never inferred from connection history or a JSON-RPC
request ID.

## Run

From the repository root:

```bash
npm install
npm run demo:mcp:e2e
```

For the shorter M4 adapter demonstration, run `npm run demo:mcp`.

## Presentation sequence

1. **Discovery first:** shows `2026-07-28`, tools capability, server identity,
   and `resultType: "complete"` without initialize or a session ID.
2. **Allow:** a support agent searches tickets; policy allows one execution and
   the normalized response contains server and correlation metadata.
3. **Opaque deny:** the same role requests a refund; execution remains unchanged
   and the response does not expose the internal policy identifier.
4. **Require approval:** a billing agent receives an explicit `approvalId` and
   `executed: false`; execution remains unchanged.
5. **Pending status:** `approvals.status` works using only the explicit handle.
6. **Human review:** the existing team-lead fixture approves the stored request;
   requester, agent, tool, arguments, and matched policy remain immutable.
7. **Stateless execution:** a new request calls `approvals.execute` with only the
   handle and receives the sanitized simulated result plus all correlation IDs.
8. **Replay protection:** the same handle with a new MCP request ID is blocked;
   the execution count does not change.
9. **Rejected approval:** a second request is rejected and cannot execute.
10. **Audit sanitization:** concise lifecycle events show requester, acting agent,
    tool, decision, review, execution, and correlation. Sensitive `token`,
    `secret`, `authorization`, and `email` values appear as `[REDACTED]`.

## What this proves

- MCP protocol behavior is request-scoped and stateless.
- Policy evaluation precedes tool execution.
- Hidden or denied tools remain opaque.
- Approval continuation is explicit and exactly-once within one process.
- Normal results carry `resultType` and server identity.
- Audit evidence correlates the original MCP request, gateway request, approval,
  reviewer, and execution without retaining sensitive values.

## Known POC limitations

- Identity and roles are explicit, untrusted fixtures—not authentication.
- Tools are deterministic simulations with no external effects.
- Approvals and audit events are in memory and disappear on restart.
- Exactly-once protection applies to this single process only.
- Approval expiry is not modeled.
- MCPack does not own a production Streamable HTTP deployment here.

Intentionally excluded: production authentication, external or durable storage,
approval expiry, dashboards, A2A, SQL analysis, OpenTelemetry, production audit
storage, and real external tool side effects.

## Troubleshooting

- Use Node.js 22 or newer.
- Run `npm install` if `tsx` or SDK modules are missing.
- Run `npm run typecheck` if local TypeScript changes prevent the demo from starting.
- The expected final execution count is `2`: one allowed ticket search and one
  approved refund. Deny, pending, replay, and rejection must not increase it.
