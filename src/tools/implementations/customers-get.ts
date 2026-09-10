import { z } from 'zod';
import { defineMockTool } from '../types.js';

const customersGetInputSchema = z
  .object({
    customerId: z.string().trim().min(1),
  })
  .strict();

export const customersGetTool = defineMockTool(
  'customers.get',
  customersGetInputSchema,
  ({ customerId }) => ({
    customerId,
    name: 'Example Customer',
    email: 'customer@example.test',
    accountStatus: 'active',
  }),
);
