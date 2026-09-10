import { z } from 'zod';
import { defineMockTool } from '../types.js';

const ticketsSearchInputSchema = z
  .object({
    query: z.string().trim().min(1),
  })
  .strict();

export const ticketsSearchTool = defineMockTool(
  'tickets.search',
  ticketsSearchInputSchema,
  ({ query }) => {
    const tickets = [
      {
        ticketId: 'ticket-001',
        summary: `Mock result for "${query}"`,
        status: 'open',
      },
    ];

    return {
      tickets,
      count: tickets.length,
    };
  },
);
