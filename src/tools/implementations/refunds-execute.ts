import { z } from 'zod';
import { defineMockTool } from '../types.js';

const refundsExecuteInputSchema = z
  .object({
    customerId: z.string().trim().min(1),
    amount: z.number().positive(),
    reason: z.string().trim().min(1),
  })
  .strict();

function stableHash(value: string): string {
  let hash = 2_166_136_261;

  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

export const refundsExecuteTool = defineMockTool(
  'refunds.execute',
  refundsExecuteInputSchema,
  ({ customerId, amount, reason }) => ({
    refundId: `refund_mock_${stableHash(`${customerId}:${amount}:${reason}`)}`,
    status: 'simulated',
    amount,
  }),
);
