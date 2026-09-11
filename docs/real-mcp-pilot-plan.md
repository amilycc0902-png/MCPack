# M6: one real read-only MCP integration

## Implemented scope

M6 is the explicit extension to the original offline POC in
[implementation-plan.md](implementation-plan.md). This guide supersedes the
previous speculative pilot plan, including its assumption that GitHub would
support MCP 2026-07-28 server/discover.

Only the opt-in pilot composition replaces tickets.search. It routes exactly to
search_issues on https://api.githubcopilot.com/mcp/readonly. refunds.execute and
customers.get continue through the existing mock registry. The default local
server and all pre-existing demos stay offline. There is no mock fallback on
upstream failure, tool auto-admission, second server, or real write capability.

## Server selection evidence (checked 2026-09-10)

- [Official GitHub MCP server releases](https://github.com/github/github-mcp-server/releases):
  version 1.12.1 released September 8, 2026, following 1.12.0 on September 3.
  Recent releases and fixes establish active maintenance at this check.
- [Remote configuration](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md):
  GitHub operates the hosted server and updates it regularly; /readonly and
  X-MCP-Readonly restrict tools to reads. X-MCP-Tools supports exact tool selection.
- [Issue tool implementation](https://github.com/github/github-mcp-server/blob/main/pkg/github/issues.go):
  search_issues has ReadOnlyHint, a required string query, and public-read scope
  handling. It searches issues and does not mutate them. The gateway's static
  allowlist is the authorization boundary; annotations alone are not authorization.
- [GitHub PAT guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens):
  use an expiring token with public read access only. For a classic PAT, no scopes
  are needed for public repository reads. Do not select repo, public_repo, or
  additional scopes for this public-read pilot. Fine-grained tokens have public
  repository read access; do not grant additional repository permissions.

These checks establish suitability, not a successful credentialed smoke test.
The hosted endpoint cannot be pinned to a release. Its runtime compatibility is
checked at each startup; the documented source release is not a claim about the
hosted version. Restart deliberately after upstream changes and rerun verification.

## Setup and use

Use Node.js 22+ and npm ci. Set these in the process environment:

| Variable | Value |
| --- | --- |
| GITHUB_PERSONAL_ACCESS_TOKEN | Expiring public-read-only PAT; required for live demo |
| REAL_MCP_TIMEOUT_MS | Optional integer 1–60000; default 5000 |

.env.example contains placeholders only. No environment file is read automatically.
Use your shell or secret injection mechanism to populate the environment; do not
put tokens in command arguments, tool calls, or committed files. Neither token
permissions nor caller identity are authenticated by MCPack. Least privilege is
an operator responsibility; a broadly privileged token can expose private data.

Run npm run demo:mcp:real-pilot. It discovers first, makes one governed public
issue search, prints a fixed success message, and closes the client. Failure
prints exactly one fixed stage label and exits nonzero. It does not print issue data,
raw errors, upstream metadata, credentials, or authorization headers.

The demo-only diagnostic labels are network_or_tls_failed, upstream_http_401,
upstream_http_403, upstream_http_404, upstream_http_other, mcp_handshake_failed,
capability_validation_failed, tool_discovery_failed, tool_annotation_failed,
unsupported_schema_dialect, unsupported_schema_keyword,
unsupported_schema_value_type, query_property_missing, query_property_not_string,
query_not_required, fixture_validation_failed, schema_validator_construction_failed,
schema_validation_other, policy_denied, tool_execution_failed, and
result_validation_failed. The executor observer carries only stage constants,
never errors or payloads, and is absent from normal gateway composition. The
demo reports only the final failed stage, not a trace of successful stages.
Connection diagnostics replace the former connection_or_authentication_failed
label. A demo-only fetch wrapper observes only success/failure and numeric status
on required POST requests; background GET/SSE requests cannot overwrite it.
401, 403 and 404 have exact labels. All other HTTP failures map to
upstream_http_other. Typed SDK StreamableHTTPError statuses use the same mapping;
the SDK's -1 content-type sentinel is not an HTTP status and stays a handshake
failure. No message text, cause, or untyped status-looking field is interpreted.
Fetch rejection maps to network_or_tls_failed. An HTTP response followed by
initialize/connect failure maps to mcp_handshake_failed (unless it was an HTTP
rejection). A missing or empty token reports environment_configuration_failed
before any network request. Other credential/timeout preflight failures still use
mcp_handshake_failed because no HTTP status was observed. This classification
does not claim to distinguish DNS, TLS, proxy, or socket root causes. Production
transport behavior and generic errors are unchanged when no observer is supplied.

Catalog parsing or
missing/duplicate/extra-page discovery failures map to tool discovery. Selected
tool annotation and cached schema checks have their own stages. JSON-RPC errors
and MCP isError results map to execution; malformed results map to validation.
Timeout reports the stage active at the deadline and is not independently diagnosed.

Success now requires statusCode === 200, decision === "allow", and executed ===
true. Because the existing gateway response does not contain an executed field,
the demo requires exactly one successful tickets.search executor completion itself. It does not infer
execution from status 200 or change production response contracts. Production
errors remain the original generic sanitized messages.

Schema diagnostics distinguish the literal expected query contract, unsupported
dialect/keywords/value types, validator construction, and fixture validation.
Malformed constraints not classified more narrowly report schema_validation_other.
Contract checks precede syntax checks; within syntax failures, dialect takes
precedence over unknown keywords, then value types. No schema, descriptions,
values, other property names, or validation issues leave this diagnostic boundary.
Argument validation at call time uses schema_validation_other.

On unsupported_schema_keyword, the live demo prints
`unsupported_schema_keyword=<safe-keyword>` for the first unsupported schema key
in depth-first object-key encounter order. It must fully match
`^\$?[A-Za-z][A-Za-z0-9_-]{0,31}$`. A failed match yields only
`unsupported_keyword_other`; subsequent keys are not searched. This replaces
the earlier fixed diagnostic-name list. Names are case-sensitive, ASCII only,
with an optional leading dollar sign and at most 32 remaining characters.
The full-match check also rejects terminal newline characters.

The traversal visits schema objects and nested property/array-item schemas, but
never uses property-map names or schema values as candidates. It does not descend
into an unsupported keyword value. Only the schema compiler can mark a validated
key as a diagnostic candidate; the demo formatter verifies that origin marker
and checks the pattern again. No descriptions, raw keys that fail validation,
values, paths, errors, or upstream metadata are printed. Schema support and
production errors remain unchanged.

For the first unsupported key `x-mcp-header`, the demo replaces the keyword line
with exactly these two lines:

```text
x_mcp_header_location=<allowlisted-location>
x_mcp_header_value_type=<allowlisted-type>
```

The root is schema_root. A direct root property schema is query_property_schema
only for the literal expected query, otherwise other_property_schema. A schema
immediately inside items is array_item_schema at any depth. Deeper property
schemas are nested_schema. No property name or path is retained in the diagnostic.
JSON types are boolean, string, number, object, array, or null; the diagnostic
stores only the category, never the value. Non-JSON types and untrusted category
labels fall back to unsupported_keyword_other. Location/type collection is
enabled only for the demo observer. The formatter verifies origin and both
allowlists. Rejected occurrences retain this diagnostic; production errors stay
generic and fail-closed.

### Narrow x-mcp-header annotation admission

The sole admitted occurrence is directly on a non-query property schema under
the root properties object. Its value must be a string fully matching
`^[A-Za-z0-9-]{1,64}$`; trailing newlines, Unicode, underscores, whitespace, empty
or oversized strings, and nonstrings fail. Root, query, array-item and deeper
nested occurrences remain rejected even with an otherwise valid string.

The compiler removes only this valid annotation from its cloned schema before
constructing the local validator. It does not mutate the discovered source,
remove a property, change required, or alter any property constraint. All other
unknown keywords and references remain rejected. Required annotated properties
remain required and can cause the unchanged query-only startup fixture to fail.

The annotation is not a header instruction: its value is never used to construct,
select, read, copy, or forward a header and is never logged or exposed. The
transport configuration, exact tool allowlist, read-only checks, timeouts, and
sanitized errors are unchanged. Caller input remains strictly query-only; even
an admitted upstream property cannot be supplied by a caller. This clears the
reported annotation incompatibility only if its value meets the bound and all
remaining schema/fixture checks pass. It does not establish a successful live run.

No additional keyword was admitted in this refinement: inspection of the public
definition does not establish the hosted schema's specific incompatibility.
Verification of the schema refinement passed: typecheck, lint, and build exited
0; all 266 tests in 22 files passed, including 127 integration tests in 4 files.
The credentialed hosted schema remains unverified here; the next opt-in live run
will report only the narrower allowlisted category if schema validation fails.
The strict model remains in src/tools/upstream-schema.ts. Default annotations no
longer accept arbitrary objects: scalars are limited to finite numbers, booleans,
null, or strings up to 16384 characters; arrays contain at most 128 such scalars.
Defaults never fill missing arguments. Unknown keywords, references, unsupported
dialects, and permissive object-valued additionalProperties remain rejected.

For HTTP use, create the executor with connectGitHubFromEnvironment(), then call
createRealMCPPilot(executor), and pass its toolCallService and approvalService to
buildApp using the existing options. Perform discovery before listening, and close
the executor when the application closes. No Fastify route changes are required.

## Execution and protocol boundaries

The downstream gateway remains stateless MCP 2026-07-28. The upstream uses the
already-installed MCP client SDK 1.27.1 Streamable HTTP transport, including its
initialize handshake, supported-version check and notifications/initialized.
This separate upstream client may use a session; it does not alter downstream
identity, discovery, metadata, approvals, or replay behavior.

Startup checks the server capabilities, obtains tools/list, admits exactly one
search_issues definition, requires readOnlyHint=true, rejects an explicit
destructiveHint=true, and snapshots its input schema. Other upstream names are
never dispatchable. Catalog pagination and duplicate selected names fail startup.
Discovery is a single snapshot and is not automatically refreshed.

Input schema validation supports a deliberately bounded JSON Schema vocabulary:
object properties/required/additionalProperties, primitive types, scalar enums,
array items and size/uniqueness, string lengths, numeric bounds, and descriptive
annotations. References, composition, patterns, formats, unknown keywords, invalid
keyword values, unsupported dialects, and incompatible required inputs fail startup.
The cached validator checks every call; the local contract additionally accepts
only a trimmed, nonempty query of at most 1024 characters. A startup probe verifies
compatibility with the public demo query and rejection of missing/nonstring query.

The client sends only query to the fixed search_issues name. Credentials come only
from the environment at the transport composition root. The HTTPS destination is
fixed, redirects are rejected, readonly and exact-tool headers are always set,
and reconnection retries are disabled. There are no automatic tool-call retries.

One configurable deadline covers all startup work; each call has its own deadline.
Timeout closes the client and aborts HTTP transport activity. Connection, protocol,
JSON-RPC, MCP isError, schema and invalid-result failures are generic. A failed
execution closes the executor; later calls fail until a new startup succeeds.
Required audit delivery still precedes execution through the existing gateway.
The gateway retains its legacy generic 'Mock tool execution failed.' wording for
compatibility even when the failed executor was upstream.

GitHub JSON text is parsed before leaving the executor. Structured results are
also accepted. Only validated issue id/title/state become ticketId/summary/status;
count is the number of returned items, not GitHub's total match count. Extra fields,
issue bodies, upstream metadata and redundant text are discarded. The existing
sanitization, MCP mapping, audit and refund redaction continue unchanged.

## Security boundaries and limitations

- All gateway user/role/agent context remains explicitly untrusted POC test context.
  A real GitHub credential does not authenticate that context.
- Read-only access prevents writes, not disclosure. Public-only PAT permissions
  are essential; neither the query nor read-only headers restrict repository access.
- Issue titles are untrusted content, including possible prompt injection or PII.
  This POC does not detect secrets or instructions embedded in arbitrary prose.
  Existing audit logging can include projected titles and search queries. Do not
  put credentials in queries. The live demo prints neither titles nor audit data.
- Upstream schema compatibility and expected JSON result shape are intentionally
  narrow. Unsupported evolution fails closed rather than silently broadening access.
- Remote updates, token expiry, permissions, quotas, proxy restrictions and protocol
  compatibility can prevent a live run. Offline CI does not establish live access.
- Storage and approval claims remain in-memory and process-local. No production
  authentication, durable storage, A2A, SQL, dashboard or side effects are added.

## Verification

Run npm run typecheck and npm test after implementation changes. Then run
npm run demo:mcp:e2e and npm run test:mcp:integration. The dedicated integration
command runs both new suites without credentials or network. Tests cover startup
and tool discovery, unsafe catalogs, schema snapshots and argument rejection,
timeouts, connection/protocol/execution failures, safe errors, exact routing,
policy denial, audit, and mock refund approval/replay behavior. Existing tests
continue to cover the full downstream protocol and redaction behavior.

The optional credentialed verification is npm run demo:mcp:real-pilot. It is never
part of npm test. Treat a missing-credential failure as configuration validation,
not a passing live integration test.

### Initial integration verification (2026-09-10, Node.js 22.17.0)

- `npm run typecheck`: exit 0.
- `npm test`: exit 0; 20 files and 185 tests passed.
- `npm run test:mcp:integration`: exit 0; 2 files and 46 tests passed.
- `npm run demo:mcp:e2e`: exit 0; final mock execution count 2, unchanged by replay or rejection.
- `npm run lint` and `npm run build`: both exit 0.
- `npm run demo:mcp:real-pilot`: exit 1 with the generic configuration failure,
  as expected without `GITHUB_PERSONAL_ACCESS_TOKEN`. No credentialed live call
  was made; hosted compatibility and access remain unverified in this environment.

### Stage diagnostics verification (2026-09-10)

`npm run typecheck`, `npm run lint`, and `npm run build` passed (exit 0).
`npm test` passed all 212 tests in 21 files. `npm run test:mcp:integration`
passed all 73 tests in 3 files. This includes all eight diagnostic stages,
secret-bearing upstream failures, malformed SDK results, policy denial, strict
success checks, unchanged production errors, and safe cleanup. These checks use
fake upstreams; rerun the opt-in live command to identify the credentialed failure.
