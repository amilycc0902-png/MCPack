import { z } from 'zod';

export const toolCallRequestSchema = z
  .object({
    requestId: z.string().trim().min(1),
    userId: z.string().trim().min(1),
    userRole: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    toolName: z.string().trim().min(1),
    arguments: z.record(z.unknown()),
  })
  .strict();

export function formatRequestIssues(error: z.ZodError): Array<{
  path: string;
  message: string;
}> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}
