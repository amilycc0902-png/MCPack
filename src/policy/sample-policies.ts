import type { Policy } from './types.js';

export const samplePolicies: readonly Policy[] = [
  {
    id: 'support-ticket-search',
    description: 'Support agents can search tickets.',
    effect: 'allow',
    subjects: ['support-agent'],
    tools: ['tickets.search'],
    conditions: [],
    priority: 100,
  },
  {
    id: 'support-refund-deny',
    description: 'Support agents cannot execute refunds.',
    effect: 'deny',
    subjects: ['support-agent'],
    tools: ['refunds.execute'],
    conditions: [],
    priority: 100,
  },
  {
    id: 'billing-refund-approval',
    description: 'Billing agent refund requests require approval.',
    effect: 'require_approval',
    subjects: ['billing-agent'],
    tools: ['refunds.execute'],
    conditions: [],
    priority: 100,
  },
  {
    id: 'unknown-tools-deny',
    description: 'All otherwise unmatched tool requests are denied.',
    effect: 'deny',
    subjects: ['*'],
    tools: ['*'],
    conditions: [],
    priority: 0,
  },
] as const;
