import type {
  Policy,
  PolicyCondition,
  PolicyDecision,
  PolicyEffect,
  RequestContext,
} from './types.js';

const effectPrecedence: Readonly<Record<PolicyEffect, number>> = {
  allow: 1,
  require_approval: 2,
  deny: 3,
};

function matchesSubject(
  requestContext: RequestContext,
  policy: Policy,
): boolean {
  const requestSubjects = new Set([
    requestContext.userId,
    requestContext.userRole,
    requestContext.agentId,
  ]);

  return policy.subjects.some(
    (subject) => subject === '*' || requestSubjects.has(subject),
  );
}

function matchesTool(requestContext: RequestContext, policy: Policy): boolean {
  return policy.tools.some(
    (tool) => tool === '*' || tool === requestContext.toolName,
  );
}

function getArgumentValue(
  argumentsValue: Record<string, unknown>,
  field: PolicyCondition['field'],
): unknown {
  const path = field.slice('arguments.'.length).split('.');
  let value: unknown = argumentsValue;

  for (const segment of path) {
    if (
      typeof value !== 'object' ||
      value === null ||
      !Object.hasOwn(value, segment)
    ) {
      return undefined;
    }

    value = (value as Record<string, unknown>)[segment];
  }

  return value;
}

function matchesCondition(
  requestContext: RequestContext,
  condition: PolicyCondition,
): boolean {
  const actualValue = getArgumentValue(
    requestContext.arguments,
    condition.field,
  );

  switch (condition.operator) {
    case 'equals':
      return Object.is(actualValue, condition.value);
  }
}

function matchesPolicy(
  requestContext: RequestContext,
  policy: Policy,
): boolean {
  return (
    matchesSubject(requestContext, policy) &&
    matchesTool(requestContext, policy) &&
    policy.conditions.every((condition) =>
      matchesCondition(requestContext, condition),
    )
  );
}

function comparePolicies(left: Policy, right: Policy): number {
  const priorityDifference = right.priority - left.priority;
  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  const effectDifference =
    effectPrecedence[right.effect] - effectPrecedence[left.effect];
  if (effectDifference !== 0) {
    return effectDifference;
  }

  return left.id.localeCompare(right.id);
}

export function evaluatePolicy(
  requestContext: RequestContext,
  policies: readonly Policy[],
): PolicyDecision {
  const matchedPolicy = policies
    .filter((policy) => matchesPolicy(requestContext, policy))
    .sort(comparePolicies)[0];

  if (!matchedPolicy) {
    return {
      decision: 'deny',
      matchedPolicyId: null,
      reason: 'No policy matched the request; access is denied by default.',
      requestId: requestContext.requestId,
    };
  }

  return {
    decision: matchedPolicy.effect,
    matchedPolicyId: matchedPolicy.id,
    reason: `Matched policy "${matchedPolicy.id}": ${matchedPolicy.description}`,
    requestId: requestContext.requestId,
  };
}
