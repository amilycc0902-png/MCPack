import { describe, expect, it } from 'vitest';
import { evaluatePolicy } from '../../src/policy/evaluator.js';
import { samplePolicies } from '../../src/policy/sample-policies.js';
import type { Policy, RequestContext } from '../../src/policy/types.js';

function createRequest(
  overrides: Partial<RequestContext> = {},
): RequestContext {
  return {
    requestId: 'request-001',
    userId: 'user-001',
    userRole: 'support-agent',
    agentId: 'agent-001',
    toolName: 'tickets.search',
    arguments: {},
    timestamp: '2026-07-30T12:00:00.000Z',
    ...overrides,
  };
}

describe('evaluatePolicy', () => {
  it('allows a support agent to search tickets', () => {
    const decision = evaluatePolicy(createRequest(), samplePolicies);

    expect(decision).toEqual({
      decision: 'allow',
      matchedPolicyId: 'support-ticket-search',
      reason:
        'Matched policy "support-ticket-search": Support agents can search tickets.',
      requestId: 'request-001',
    });
  });

  it('denies a support agent attempting to execute a refund', () => {
    const decision = evaluatePolicy(
      createRequest({ toolName: 'refunds.execute' }),
      samplePolicies,
    );

    expect(decision.decision).toBe('deny');
    expect(decision.matchedPolicyId).toBe('support-refund-deny');
  });

  it('requires approval for a billing agent executing a refund', () => {
    const decision = evaluatePolicy(
      createRequest({
        userRole: 'billing-agent',
        toolName: 'refunds.execute',
      }),
      samplePolicies,
    );

    expect(decision.decision).toBe('require_approval');
    expect(decision.matchedPolicyId).toBe('billing-refund-approval');
  });

  it('denies an unknown tool through the fallback policy', () => {
    const decision = evaluatePolicy(
      createRequest({ toolName: 'unknown.tool' }),
      samplePolicies,
    );

    expect(decision.decision).toBe('deny');
    expect(decision.matchedPolicyId).toBe('unknown-tools-deny');
  });

  it('uses the highest-priority matching policy', () => {
    const conflictingPolicies: Policy[] = [
      {
        id: 'low-priority-allow',
        description: 'A broad low-priority allowance.',
        effect: 'allow',
        subjects: ['support-agent'],
        tools: ['tickets.search'],
        conditions: [],
        priority: 10,
      },
      {
        id: 'high-priority-deny',
        description: 'A specific high-priority denial.',
        effect: 'deny',
        subjects: ['support-agent'],
        tools: ['tickets.search'],
        conditions: [],
        priority: 20,
      },
    ];

    const decision = evaluatePolicy(createRequest(), conflictingPolicies);

    expect(decision.decision).toBe('deny');
    expect(decision.matchedPolicyId).toBe('high-priority-deny');
  });

  it('denies by default when no policy matches', () => {
    const decision = evaluatePolicy(createRequest(), []);

    expect(decision).toEqual({
      decision: 'deny',
      matchedPolicyId: null,
      reason: 'No policy matched the request; access is denied by default.',
      requestId: 'request-001',
    });
  });

  it('matches deterministic argument equality conditions', () => {
    const conditionalPolicy: Policy = {
      id: 'ticket-region-allow',
      description: 'Allow ticket searches in the configured region.',
      effect: 'allow',
      subjects: ['support-agent'],
      tools: ['tickets.search'],
      conditions: [
        {
          field: 'arguments.filters.region',
          operator: 'equals',
          value: 'us-east',
        },
      ],
      priority: 100,
    };

    const decision = evaluatePolicy(
      createRequest({
        arguments: {
          filters: {
            region: 'us-east',
          },
        },
      }),
      [conditionalPolicy],
    );

    expect(decision.decision).toBe('allow');
    expect(decision.matchedPolicyId).toBe('ticket-region-allow');
  });

  it('uses deny as the safe tie-breaker at equal priority', () => {
    const equalPriorityPolicies: Policy[] = [
      {
        id: 'allow-policy',
        description: 'Allow the call.',
        effect: 'allow',
        subjects: ['support-agent'],
        tools: ['tickets.search'],
        conditions: [],
        priority: 100,
      },
      {
        id: 'deny-policy',
        description: 'Deny the call.',
        effect: 'deny',
        subjects: ['support-agent'],
        tools: ['tickets.search'],
        conditions: [],
        priority: 100,
      },
    ];

    const decision = evaluatePolicy(createRequest(), equalPriorityPolicies);

    expect(decision.decision).toBe('deny');
    expect(decision.matchedPolicyId).toBe('deny-policy');
  });
});
