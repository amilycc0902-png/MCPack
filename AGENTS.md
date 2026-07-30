# MCPack Repository Instructions

## Source of Truth

- Treat `docs/implementation-plan.md` as the authoritative scope for the MCPack Policy Gateway POC.
- Do not expand implementation scope beyond `docs/implementation-plan.md`.
- Do not modify unrelated existing files.

## Runtime and Language

- Use TypeScript and Node.js 22 or newer.
- Keep TypeScript strict.
- Keep the first POC locally runnable.

## Architecture

- Keep the policy engine transport-neutral.
- Separate policy evaluation, approval handling, tool execution, output redaction, and audit logging.
- Use deterministic policy rules. Do not use an LLM for policy decisions.
- Use in-memory storage or local JSON storage for the POC.
- Treat all identity context in the POC as explicitly untrusted test context. Do not describe it as authenticated or production-ready.

## POC Scope Exclusions

Do not add any of the following to the first POC:

- Agent-to-agent (A2A) behavior
- SQL analysis
- Production authentication
- Dashboards
- External databases
- Real external side effects

Use simulated, deterministic tool execution instead of calling real external systems.

## Testing and Verification

- Every implemented behavior must include tests.
- Run `npm run typecheck` and `npm test` after each implementation step.
- Do not consider an implementation step complete until both commands pass.

## Documentation

- Update `README.md` whenever setup or usage changes.
- Keep documentation consistent with `docs/implementation-plan.md`.
