import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createDefaultApprovalService,
  type ApprovalService,
} from './approval/approval-service.js';
import {
  createDefaultToolCallService,
  type ToolCallService,
} from './gateway/tool-call-service.js';
import { registerApprovalRoutes } from './http/approval-routes.js';
import { registerToolCallRoute } from './http/tool-call-route.js';
import { evaluatePolicy } from './policy/evaluator.js';
import { samplePolicies } from './policy/sample-policies.js';
import { defaultToolRegistry } from './tools/registry.js';
import { createAuditService } from './audit/audit-service.js';
import { InMemoryAuditSink } from './audit/in-memory-audit-sink.js';
import type { AuditSink } from './audit/types.js';

const healthResponseSchema = z.object({
  status: z.literal('ok'),
});

export interface BuildAppOptions {
  toolCallService?: ToolCallService;
  approvalService?: ApprovalService;
  auditSink?: AuditSink;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
  });
  const audit = createAuditService(
    options.auditSink ?? new InMemoryAuditSink(),
  );
  const approvalService =
    options.approvalService ??
    createDefaultApprovalService(
      defaultToolRegistry,
      samplePolicies,
      evaluatePolicy,
      audit,
    );
  const toolCallService =
    options.toolCallService ??
    createDefaultToolCallService(approvalService, audit);

  app.get('/health', async () => {
    return healthResponseSchema.parse({ status: 'ok' });
  });

  registerToolCallRoute(app, toolCallService);
  registerApprovalRoutes(app, approvalService);

  return app;
}
