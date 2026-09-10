const sensitiveFieldTerms = [
  'password',
  'token',
  'secret',
  'authorization',
  'email',
] as const;

function isSensitiveField(key: string): boolean {
  const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  return sensitiveFieldTerms.some((term) => normalizedKey.includes(term));
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        isSensitiveField(key) ? '[REDACTED]' : sanitizeValue(nestedValue),
      ]),
    );
  }

  return value;
}

export function sanitizeAuditData(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeValue(value) as Record<string, unknown>;
}

export function sanitizeAuditResult(value: unknown): unknown {
  return sanitizeValue(value);
}
