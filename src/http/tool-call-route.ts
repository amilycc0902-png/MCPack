import type { FastifyInstance } from 'fastify';
import type { ToolCallService } from '../gateway/tool-call-service.js';
import type { ToolCallRequest } from '../gateway/types.js';
import {
  formatRequestIssues,
  toolCallRequestSchema,
} from './request-schema.js';

export function registerToolCallRoute(
  app: FastifyInstance,
  service: ToolCallService,
): void {
  app.post('/v1/tools/call', async (request, reply) => {
    const parsedRequest = toolCallRequestSchema.safeParse(request.body);

    if (!parsedRequest.success) {
      return reply.status(400).send({
        error: 'Invalid request body.',
        issues: formatRequestIssues(parsedRequest.error),
      });
    }

    const result = await service.handle(parsedRequest.data as ToolCallRequest);
    return reply.status(result.statusCode).send(result.body);
  });
}
