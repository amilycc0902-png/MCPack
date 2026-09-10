import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ApprovalService } from '../approval/approval-service.js';
import type { ToolCallRequest } from '../gateway/types.js';
import {
  formatRequestIssues,
  toolCallRequestSchema,
} from './request-schema.js';

const approvalParamsSchema = z.object({
  id: z.string().trim().min(1),
});

const approvalReviewSchema = z
  .object({
    reviewedBy: z.string().trim().min(1),
    reviewerRole: z.string().trim().min(1),
  })
  .strict();

export function registerApprovalRoutes(
  app: FastifyInstance,
  service: ApprovalService,
): void {
  app.post('/v1/approvals', async (request, reply) => {
    const parsedRequest = toolCallRequestSchema.safeParse(request.body);
    if (!parsedRequest.success) {
      return reply.status(400).send({
        error: 'Invalid request body.',
        issues: formatRequestIssues(parsedRequest.error),
      });
    }

    const result = await service.requestApproval(
      parsedRequest.data as ToolCallRequest,
    );
    return reply.status(result.statusCode).send(result.body);
  });

  app.get('/v1/approvals/:id', async (request, reply) => {
    const parsedParams = approvalParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.status(400).send({ error: 'Invalid approval ID.' });
    }

    const result = service.get(parsedParams.data.id);
    return reply.status(result.statusCode).send(result.body);
  });

  app.post('/v1/approvals/:id/approve', async (request, reply) => {
    return handleReview(request.params, request.body, reply, service, true);
  });

  app.post('/v1/approvals/:id/reject', async (request, reply) => {
    return handleReview(request.params, request.body, reply, service, false);
  });

  app.post('/v1/approvals/:id/execute', async (request, reply) => {
    const parsedParams = approvalParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.status(400).send({ error: 'Invalid approval ID.' });
    }

    const result = await service.execute(parsedParams.data.id);
    return reply.status(result.statusCode).send(result.body);
  });
}

async function handleReview(
  params: unknown,
  body: unknown,
  reply: FastifyReply,
  service: ApprovalService,
  approve: boolean,
): Promise<unknown> {
  const parsedParams = approvalParamsSchema.safeParse(params);
  const parsedBody = approvalReviewSchema.safeParse(body);
  if (!parsedParams.success || !parsedBody.success) {
    return reply
      .status(400)
      .send({ error: 'Invalid approval review request.' });
  }

  const result = approve
    ? await service.approve(parsedParams.data.id, parsedBody.data)
    : await service.reject(parsedParams.data.id, parsedBody.data);
  return reply.status(result.statusCode).send(result.body);
}
