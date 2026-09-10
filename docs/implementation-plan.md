# MCPack Policy Gateway Implementation Plan

## Purpose and scope

This plan turns the Policy Gateway PRD into an implementation sequence for the existing `@llvs/mcpack` TypeScript library. It intentionally distinguishes:

- the **first demonstrable POC**, which proves one complete governed tool-call flow with local, in-memory components; and
- **V1**, which adds the minimum breadth needed for a coherent developer-facing policy gateway.

The first POC must prove:

```text
tool call request
  -> identity and policy evaluation
  -> allow, deny, or require approval
  -> simulated MCP tool execution
  -> output redaction
  -> audit logging
```

No production system, real payment action, database, A2A delegation, or production-grade identity provider is required.

## 1. Core product promise

MCPack is a policy enforcement and evidence layer between AI agents and MCP tools. It gives each agent only the tools it may discover, evaluates every attempted action against the identity and policy context, pauses risky calls for authorized human approval, limits the returned data, and records why each decision occurred.

The promise is not merely "MCP connectivity." It is:

> Let teams safely connect agents to business tools while retaining control over who can discover, request, approve, execute, and see the results of each action.

For the POC, the promise is demonstrated locally with deterministic policy, a simulated tool catalog, a local approval API, structured redaction, and an in-memory audit trail.

## 2. Smallest demonstrable POC

### Demonstration scenario

Use one simulated customer-support MCP server with three tools:

| Tool | Intended outcome | Example policy |
| --- | --- | --- |
| `tickets.search` | Read-only lookup | Allow |
| `customers.delete` | Destructive operation | Deny and keep opaque to unauthorized agents |
| `payments.refund` | Financial operation | Require approval |

The `payments.refund` simulator returns a deliberately over-broad structured result containing `customerName`, `email`, `refundStatus`, `paymentMethod`, and `internalNotes`. The return policy exposes `customerName` and `refundStatus` and replaces the remaining protected fields with `[REDACTED]`.

### Required demo paths

1. **Allow:** a known support agent requests `tickets.search`; MCPack evaluates identity and policy, executes the simulator immediately, applies the return policy, returns the result, and records the full decision path.
2. **Deny:** the same agent requests `customers.delete`; MCPack does not invoke the simulator, returns an opaque not-found-style error where tool secrecy applies, and logs the denied attempt.
3. **Require approval:** the agent requests `payments.refund`; MCPack creates a pending approval and returns its ID without invoking the simulator. An authorized local approver approves it through the HTTP API. MCPack executes the stored request exactly once, redacts its output, finalizes the approval, and records every transition.
4. **Reject:** an approver rejects a second refund request; the simulator is never invoked and the rejection is audited.

### POC boundary

The POC is a local process using:

- one static `policy.json`;
- fixture identities and roles;
- an explicit request envelope containing identity context;
- a deterministic policy evaluator;
- an in-memory approval repository;
- an in-memory append-only audit repository;
- simulated MCP tool handlers;
- a small local HTTP approval/status API; and
- automated integration tests plus a runnable demo script.

The POC does not need a UI. Restarting the process may clear approvals and audit events.

## 3. What should be included in V1

V1 should retain the same core pipeline and add developer-facing completeness:

### Policy and identity

- Local JSON policy file loaded and validated at startup.
- Human users, agents, roles, and role assignments.
- Separate `originalRequester` and `actingAgent` fields on every request.
- Agent-specific tool visibility and call authorization.
- Deterministic conflict resolution with this precedence:
  `deny > require_approval > allow`.
- Default deny when identity, role mapping, tool mapping, or policy evaluation is invalid or ambiguous.
- Policy decision reasons and matched rule IDs.

### MCP behavior

- Existing lazy, role-filtered `search_tools` behavior.
- A governed call pipeline shared by wrap and build modes.
- Opaque denial for hidden or out-of-role tools.
- Input validation before policy evaluation and execution.
- Upstream execution only after an allow decision or a valid approval.

### Approval

- Pending approval creation with the complete safe review context.
- List, detail, approve, reject, expire, and status-poll operations.
- Approver-role authorization.
- Configurable expiry.
- Exactly-once execution guard for approved requests.
- Structured pending, rejected, expired, completed, and failed responses.

### Return policy

- Path-based structured JSON redaction.
- Stable `[REDACTED]` markers that preserve response shape.
- Role-specific return policies.
- Optional whole-response blocking when a configured sensitive path is present.
- Redaction metadata in the audit event without copying secret values into the log.

### Audit and operability

- One `workflowId` and one `toolCallId` connecting all events.
- Append-only audit events for request receipt, identity resolution, policy decision, approval transitions, execution, redaction, failure, and completion.
- Local JSON export and filtering by workflow, actor, agent, tool, decision, approval status, and time range.
- Clear startup errors for invalid policy files.
- Library APIs that allow storage, identity, execution, and audit adapters to be replaced later.

### Documentation and quality

- Policy schema reference and working examples.
- A local quickstart that reaches the first governed result in under 15 minutes.
- Unit tests for policy precedence, redaction, approval authorization, and state transitions.
- End-to-end tests for allow, deny, approve, reject, expire, execution failure, and redaction.
- No regression to the existing RBAC and lazy-discovery behavior.

## 4. What should be excluded from this POC

The following are explicitly out of the first implementation:

- A2A communication, delegation, multi-hop workflows, and delegated credentials.
- SQL parsing, query classification, cost estimation, timeouts, or query-safety analysis.
- Production authentication, OAuth/OIDC, JWT validation, SSO, API keys, or identity-provider integrations.
- External databases, queues, caches, object stores, or immutable ledgers.
- Walacor or other tamper-evident audit integrations.
- Web dashboard, policy editor, or approval UI.
- Slack, Teams, email, SMS, or webhook notifications.
- Natural-language policy authoring or model-based policy decisions.
- Unstructured-text PII detection, secret scanning, or probabilistic redaction.
- Real payment, customer, deployment, email, filesystem, or database side effects.
- Multi-server routing, remote MCP transport management, clustering, or horizontal scaling.
- Policy hot reload, migrations, version negotiation, and rollback.
- Production availability, durability, performance, and compliance claims.

The data model may reserve `originalRequester`, `actingAgent`, and `workflowId` because they are required for current auditability and future delegation. It should not add A2A-specific evaluators, routes, or state machines.

## 5. Proposed TypeScript architecture

### Architectural direction

Extend the existing "two modes, one engine" pattern rather than building an unrelated service. The current `MCPackEngine` remains responsible for discovery/session behavior. A new, transport-neutral policy gateway pipeline governs calls from both wrap and build adapters.

```text
MCP adapter or local HTTP demo
        |
        v
Request envelope + trusted POC identity context
        |
        v
PolicyGateway
  1. validate request
  2. resolve identity/roles
  3. evaluate visibility and action policy
  4. deny | create approval | execute
  5. apply return policy
  6. append audit events
        |
        +--> ApprovalService --> ApprovalRepository (memory)
        +--> ToolExecutor ----> simulated MCP handlers
        +--> RedactionEngine
        +--> AuditSink --------> AuditRepository (memory)
```

### Proposed modules

The exact filenames can change during implementation, but responsibilities should remain separate:

```text
src/
  policy/
    types.ts                 policy document and rule types
    loader.ts                parse, validate, and snapshot policy.json
    evaluator.ts             deterministic matching and precedence
  identity/
    resolver.ts              resolve supplied POC subject IDs to roles
  gateway/
    types.ts                 request, decision, and result contracts
    policy-gateway.ts        orchestration pipeline
  approval/
    approval-service.ts      transition rules and execution-on-approval
    repository.ts            interface plus in-memory implementation
  redaction/
    redaction-engine.ts      structured path masking/blocking
  audit/
    audit-sink.ts            interface plus in-memory implementation
  execution/
    tool-executor.ts         interface and MCP/simulator adapters
  api/
    approval-http-server.ts  local POC HTTP routes
  demo/
    simulated-tools.ts       deterministic, side-effect-free tools
```

### Design constraints

- **Transport-neutral core:** `PolicyGateway.evaluateAndDispatch()` must not depend on HTTP request objects or MCP SDK internals.
- **Single enforcement point:** wrap mode, build mode, and the demo API must use the same pipeline.
- **Dependency injection:** the gateway receives `IdentityResolver`, `PolicyEvaluator`, `ApprovalRepository`, `ToolExecutor`, `RedactionEngine`, `AuditSink`, `Clock`, and `IdGenerator` interfaces.
- **Safe defaults:** unknown identity, missing policy context, invalid rules, hidden tools, and conflicting same-precedence outcomes resolve to denial.
- **Determinism:** policy evaluation and redaction do not call an LLM.
- **Immutable snapshots:** load and validate the policy once at startup for the POC, following the existing config-snapshot pattern.
- **No new runtime dependency by default:** prefer Node built-ins and the current SDK. Any proposed dependency must be separately approved because the package currently has one peer runtime dependency.
- **Error isolation:** distinguish policy denial, approval pending, upstream failure, invalid output, and internal failure in typed internal results, while retaining opaque external responses where secrecy is required.

### Integration with current MCPack behavior

- Preserve `search_tools` as the only discovery tool and apply the new identity-aware visibility policy before ranking.
- Replace reliance on one process-wide `defaultRole` for governed calls with roles resolved from the request context.
- Move the current direct proxy/handler execution behind `ToolExecutor`.
- Keep the existing out-of-role `"Unknown tool"` behavior.
- Treat the existing optional tool-call observation hook as diagnostics, not as an identity or authorization mechanism.

### Important protocol limitation

A normal MCP `tools/call` request supplies a tool name and arguments; it does not, by itself, guarantee a verified original human identity, business role, or original user prompt. The POC must therefore use an explicit `PolicyRequestContext` supplied by its trusted local harness/adapter. It must not describe that context as authenticated.

The policy gateway API should make this trust boundary explicit so a future transport adapter can populate the same contract from real authentication without changing policy evaluation.

## 6. Main data models

The following are conceptual TypeScript shapes, not final code.

### Policy document

```ts
interface PolicyDocument {
  version: 1;
  subjects: {
    users: SubjectDefinition[];
    agents: SubjectDefinition[];
  };
  roles: RoleDefinition[];
  toolRules: ToolRule[];
  returnRules: ReturnRule[];
  approval?: ApprovalPolicy;
}

interface SubjectDefinition {
  id: string;
  roles: string[];
  enabled: boolean;
}

interface RoleDefinition {
  id: string;
  inherits?: string[];
}

interface ToolRule {
  id: string;
  priority?: number;
  principals: {
    userRoles?: string[];
    agentRoles?: string[];
  };
  tools: string[];
  effect: "allow" | "deny" | "require_approval";
  conditions?: Condition[];
  approverRoles?: string[];
}

interface ReturnRule {
  id: string;
  principals: {
    userRoles?: string[];
    agentRoles?: string[];
  };
  tools: string[];
  redactPaths?: string[];
  blockIfPresent?: string[];
}
```

POC conditions should support only simple, explicit comparisons against tool arguments, such as refund amount thresholds. No general expression language is needed.

### Request and identity context

```ts
interface GovernedToolCallRequest {
  toolCallId: string;
  workflowId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  context: PolicyRequestContext;
}

interface PolicyRequestContext {
  originalRequester: {
    type: "user";
    id: string;
  };
  actingAgent: {
    type: "agent";
    id: string;
  };
  sessionId?: string;
  requestReason?: string;
}

interface ResolvedIdentityContext {
  originalRequesterId: string;
  originalRequesterRoles: string[];
  actingAgentId: string;
  actingAgentRoles: string[];
}
```

### Decision

```ts
type PolicyEffect = "allow" | "deny" | "require_approval";

interface PolicyDecision {
  effect: PolicyEffect;
  reasonCode: string;
  matchedRuleIds: string[];
  approverRoles?: string[];
  returnRuleIds: string[];
  policyVersion: number;
}
```

`redact` is a return-policy obligation, not a peer action decision. This keeps the control flow unambiguous: an allowed or approved call may also require redaction.

### Approval

```ts
type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "executing"
  | "completed"
  | "failed";

interface ApprovalRequest {
  id: string;
  status: ApprovalStatus;
  workflowId: string;
  toolCallId: string;
  requestedAt: string;
  expiresAt: string;
  requiredApproverRoles: string[];
  safeReviewContext: {
    requesterId: string;
    actingAgentId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    reasonCode: string;
    matchedRuleIds: string[];
  };
  storedCall: GovernedToolCallRequest;
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionNote?: string;
}
```

The POC policy must define which input fields are safe to expose in `safeReviewContext`; credentials or secret arguments must never be copied blindly.

### Result

```ts
type GovernedToolCallResult =
  | { status: "completed"; toolCallId: string; workflowId: string; output: unknown }
  | { status: "denied"; toolCallId: string; workflowId: string; code: string }
  | { status: "pending_approval"; toolCallId: string; workflowId: string; approvalId: string; expiresAt: string }
  | { status: "rejected" | "expired" | "failed"; toolCallId: string; workflowId: string; code: string };
```

### Audit event

```ts
type AuditEventType =
  | "request.received"
  | "identity.resolved"
  | "identity.failed"
  | "policy.decided"
  | "approval.created"
  | "approval.approved"
  | "approval.rejected"
  | "approval.expired"
  | "execution.started"
  | "execution.completed"
  | "execution.failed"
  | "output.redacted"
  | "output.blocked"
  | "workflow.completed";

interface AuditEvent {
  id: string;
  sequence: number;
  occurredAt: string;
  type: AuditEventType;
  workflowId: string;
  toolCallId: string;
  actor?: { type: "user" | "agent" | "system"; id: string };
  toolName?: string;
  decision?: PolicyEffect;
  reasonCode?: string;
  ruleIds?: string[];
  approvalId?: string;
  metadata?: Record<string, unknown>;
}
```

Audit metadata should contain field paths, counts, statuses, and hashes where useful, but not raw protected output, credentials, or unredacted approval inputs.

## 7. API endpoints

These are local POC endpoints. They are not a production public API and must bind to loopback by default.

| Method and path | Purpose | POC behavior |
| --- | --- | --- |
| `POST /v1/tool-calls` | Submit a governed tool call | Returns completed, denied, or pending-approval result |
| `GET /v1/tool-calls/{toolCallId}` | Poll final call state/result | Returns current state; useful after approval |
| `GET /v1/agents/{agentId}/manifest` | Retrieve visible tools for one fixture agent | Returns only policy-visible MCP tool schemas |
| `GET /v1/approvals` | List approvals | Supports at least `status` filtering |
| `GET /v1/approvals/{approvalId}` | Read safe approval context and state | Never returns unredacted protected data |
| `POST /v1/approvals/{approvalId}/approve` | Approve as a fixture user | Verifies the supplied fixture approver role, then triggers exactly-once execution |
| `POST /v1/approvals/{approvalId}/reject` | Reject as a fixture user | Verifies role and records the reason |
| `GET /v1/audit-events` | Inspect/export local audit events | Filters by `workflowId`, `toolCallId`, `tool`, `decision`, or `type` |

Example POC request:

```json
{
  "workflowId": "wf-demo-001",
  "toolName": "payments.refund",
  "arguments": {
    "customerId": "cus_123",
    "amount": 500
  },
  "context": {
    "originalRequester": {
      "type": "user",
      "id": "user_support_1"
    },
    "actingAgent": {
      "type": "agent",
      "id": "agent_support_1"
    },
    "requestReason": "Duplicate charge"
  }
}
```

For the POC, approver identity may be supplied explicitly in the approval request body or a clearly named fixture-only header. The server must label this mode as untrusted/demo identity and bind to `127.0.0.1`. Production bearer authentication is out of scope.

## 8. Step-by-step implementation plan

### Phase 0 - Confirm contracts and protect current behavior

1. Record the current wrap/build, RBAC, `search_tools`, session, and opaque-denial behavior with characterization tests.
2. Finalize the request trust boundary: the gateway accepts explicit identity context from adapters but does not authenticate it in the POC.
3. Finalize the three POC tools, fixture users/agents, policy rules, safe approval arguments, and redaction paths.
4. Define reason codes and external result states before implementation.

**Exit condition:** expected allow, deny, approval, rejection, redaction, and audit outcomes are expressed as test fixtures.

### Phase 1 - Define and validate policy

1. Add policy, identity, decision, return-policy, and condition model types.
2. Implement strict startup validation for duplicate IDs, missing roles, invalid tool patterns, unsupported conditions, missing approver roles, and invalid redaction paths.
3. Load and deep-snapshot `policy.json`.
4. Add a sample POC policy covering all three decision branches.

**Exit condition:** valid policy loads; invalid or ambiguous policy fails startup with a field-specific message.

### Phase 2 - Build deterministic identity and policy evaluation

1. Resolve fixture user and agent IDs independently.
2. Resolve role inheritance with cycle protection.
3. Match tool rules and supported argument conditions.
4. Apply explicit priority and safe effect precedence.
5. Return a structured decision with reason code, matched rule IDs, approver roles, and return-policy obligations.
6. Default deny on unknown/disabled subjects, tools, or invalid context.

**Exit condition:** table-driven tests cover each effect, threshold boundaries, conflicts, role inheritance, unknown identities, and default denial.

### Phase 3 - Build audit foundation

1. Define the audit event union and sink interface.
2. Implement an in-memory append-only sink with per-workflow sequence numbers.
3. Add event sanitization so raw protected results and unsafe arguments cannot enter audit metadata.
4. Emit events from request receipt through policy decision, including failures.
5. Add filtering/export queries used by the POC API.

**Exit condition:** every decision path creates an ordered, correlated event chain and tests verify forbidden values are absent.

### Phase 4 - Build execution and redaction

1. Define the `ToolExecutor` interface.
2. Implement deterministic simulators with invocation counters for the three POC tools.
3. Implement structured object/array path redaction with `[REDACTED]` markers.
4. Implement configured whole-response blocking.
5. Apply redaction only after successful execution and before results leave the gateway.
6. Record redacted paths and block reasons, never raw sensitive values.

**Exit condition:** allowed execution returns a usable filtered structure; denied calls invoke no tool; sensitive values appear in neither response nor audit log.

### Phase 5 - Build approval state machine

1. Implement the in-memory approval repository and explicit transition table.
2. Store the canonical call and safe review context when a decision requires approval.
3. Authorize the approver by resolved fixture role.
4. Support approve, reject, expire, and poll.
5. Add an atomic execution claim (`approved -> executing`) so repeated approvals or polls cannot run the tool twice.
6. On approval, re-check expiry and optionally re-evaluate against the same policy snapshot, execute once, redact, store the safe final result, and finalize status.
7. Audit every successful and rejected transition, including unauthorized approval attempts.

**Exit condition:** pending calls never execute early; authorized approval executes once; rejection/expiry never executes; unauthorized or repeated approval cannot bypass the state machine.

### Phase 6 - Assemble the gateway pipeline

1. Implement `PolicyGateway` as the sole orchestrator.
2. Return typed internal results and map them to stable MCP/HTTP responses at adapters.
3. Ensure all terminal and recoverable failure paths emit appropriate audit events.
4. Integrate identity-aware discovery with the existing role-filtered index.
5. Route existing wrap/build tool calls through the same gateway without changing `search_tools` semantics.

**Exit condition:** wrap mode, build mode, and direct POC calls share the same decision/execution/redaction path.

### Phase 7 - Add the local API and demo

1. Add a loopback-only HTTP server using Node built-ins unless an approved dependency is justified.
2. Implement the endpoints in Section 7, request-size limits, JSON content checks, and consistent error responses.
3. Add the sample policy, fixture identities, and demo command.
4. Create a script or documented command sequence that demonstrates allow, deny, approve, reject, redaction, and audit inspection.
5. Clearly label identity and persistence as local POC mechanisms.

**Exit condition:** a fresh local run demonstrates the full requested flow without external services or environment variables.

### Phase 8 - Verification and V1 hardening

1. Add end-to-end tests for every POC path and failure mode.
2. Add regression tests for current lazy discovery, schema gating, sessions, and RBAC.
3. Run typecheck, build, test, and coverage.
4. Verify no new environment variables or runtime dependencies were introduced without board approval and documentation.
5. Document known limitations and the adapter seams for future production identity, persistence, notifications, and immutable audit storage.
6. Benchmark policy evaluation with a representative local policy set; record results without making production performance claims.

**Exit condition:** all acceptance criteria below pass and the quickstart is reproducible.

## 9. Acceptance criteria

### Core flow

- [ ] A governed request contains a unique `toolCallId` and `workflowId`.
- [ ] The gateway independently resolves the original fixture user and acting fixture agent.
- [ ] Unknown, disabled, or unmapped identities fail closed and are audited.
- [ ] Every request produces exactly one action decision: allow, deny, or require approval.
- [ ] Conflicts resolve deterministically as `deny > require_approval > allow`.

### Allow and deny

- [ ] An allowed call executes the intended simulator once and returns its governed result.
- [ ] A denied call never invokes the simulator.
- [ ] A hidden/out-of-role tool is absent from the agent manifest.
- [ ] Direct attempts to call a hidden tool receive an opaque not-found-style response.
- [ ] Allowed and denied decisions record matched rule IDs and a stable reason code.

### Approval

- [ ] An approval-required call returns a structured pending result containing `approvalId` and `expiresAt`.
- [ ] The simulator invocation count remains zero while approval is pending.
- [ ] Only a fixture user with one of the required approver roles may approve or reject.
- [ ] Unauthorized approval attempts fail and are audited.
- [ ] Authorized approval executes the stored request exactly once.
- [ ] Repeated approval, concurrent approval, rejection, or polling cannot execute the tool a second time.
- [ ] Rejected and expired requests never execute.
- [ ] Approval detail exposes enough context to decide safely without exposing configured secret arguments.

### Redaction

- [ ] Structured protected fields are replaced with `[REDACTED]` while object/array shape is preserved.
- [ ] Return policy is selected using both requester and acting-agent context.
- [ ] Configured highly sensitive fields cause the entire response to be blocked.
- [ ] Unredacted protected values do not appear in HTTP/MCP responses, stored approval results, or audit metadata.
- [ ] Audit events identify redacted field paths and the rule that required redaction.

### Audit

- [ ] Every request records receipt, identity result, policy decision, and terminal state.
- [ ] Approval flows additionally record creation and every attempted transition.
- [ ] Executed flows record execution start/result status and redaction/blocking.
- [ ] Events for one workflow have stable correlation IDs and monotonically increasing sequence numbers.
- [ ] Audit filtering by workflow, tool call, tool, decision, and event type works.
- [ ] Restart durability and tamper evidence are explicitly documented as unsupported in the POC.

### Developer experience and regression safety

- [ ] The sample policy fails fast with actionable errors when deliberately corrupted.
- [ ] A developer can run the complete demo locally without credentials, external databases, or third-party services.
- [ ] The quickstart reaches a first governed tool result in under 15 minutes.
- [ ] Existing MCPack tests continue to pass.
- [ ] Typecheck and build pass under the repository's supported Node and TypeScript configuration.
- [ ] No production authentication, A2A, SQL analysis, external database, or real side-effecting tool slips into the POC.

## 10. Risks and assumptions

### Risks

| Risk | Impact | Mitigation in POC/V1 |
| --- | --- | --- |
| MCP calls lack verified human/request context | Policy could authorize based on spoofable metadata | Make the trust boundary explicit; use fixture context only; require a future authenticated adapter for production |
| Approval retry or race executes a tool twice | Duplicate financial or destructive action | Atomic state transition, stable tool-call ID, exactly-once execution claim, and idempotency tests |
| Audit logs leak the data they are meant to govern | Security and compliance failure | Allowlisted metadata, centralized sanitization, no raw output, tests with sentinel secrets |
| Redaction paths miss fields or mishandle arrays | Sensitive output exposure | Strict structured paths, fail-safe whole-response block option, nested object/array tests |
| Rule conflicts create unexpected access | Unsafe allow decision | Deterministic precedence, explicit priorities, startup validation, decision explanations |
| Hidden-tool denial leaks existence through different errors | Expands agent knowledge and attack surface | Use the same opaque not-found behavior for absent and unauthorized tools |
| Policy changes between request and approval | Approved action may execute under unclear rules | POC uses an immutable policy snapshot and records its version; define V1 re-evaluation semantics before hot reload |
| In-memory state is mistaken for reliable workflow storage | Pending approvals and logs disappear on restart | Label POC behavior clearly; keep repository interfaces ready for a later durable adapter |
| Existing `defaultRole` assumptions conflict with per-request identity | Incorrect discovery or enforcement | Introduce request-scoped resolved roles and add regression tests before changing adapters |
| Scope expands toward dashboard, A2A, SQL, or integrations | Delays proof of the core gateway | Enforce the exclusions in Section 4 as phase gates |
| New dependencies expand package/runtime surface | Release and maintenance risk | Prefer Node built-ins; require board approval and documented rationale for runtime additions |

### Assumptions

- The POC runs locally and is trusted only as a demonstration.
- The caller supplies a `PolicyRequestContext`; MCPack validates its shape and mapping but does not authenticate it.
- Policies and fixture identities are controlled by the developer running the POC.
- Simulated tool outputs are JSON-compatible structured data.
- Redaction in the POC is deterministic and path-based, not semantic or probabilistic.
- One process owns approval state, execution claims, and audit sequence generation.
- Policy is loaded once at startup and does not hot reload.
- Approval execution may occur synchronously in the local process; a durable worker/queue is not required.
- The current package remains ESM-only, Node.js 18+, strict TypeScript, and compatible with the existing MCP SDK peer dependency.
- Any future external persistence, production authentication, notification channel, or tamper-evident log will implement the defined interfaces rather than changing the gateway's core decision model.

## Recommended implementation decision

Proceed with the first POC as a vertical slice, not as a partial dashboard or broad policy language. The strongest demonstration is a single local command sequence that proves all three decisions, proves that approval gates execution, proves that output is reduced before release, and shows a correlated audit chain for every step.
