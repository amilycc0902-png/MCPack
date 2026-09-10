import { SERVER_INFO_META_KEY, type Implementation } from '@modelcontextprotocol/server';
import type { MCPackResult } from '../types.js';

export function normalizeMCPResult(
  value: unknown,
  serverInfo: Implementation,
): MCPackResult {
  const normalized = normalizeValue(value);
  const existingMeta = isRecord(normalized._meta) ? normalized._meta : {};
  const existingServerInfo = existingMeta[SERVER_INFO_META_KEY];
  if (
    existingServerInfo !== undefined &&
    JSON.stringify(existingServerInfo) !== JSON.stringify(serverInfo)
  ) {
    throw new Error(
      'MCPack: upstream result server identity conflicts with discovered server identity.',
    );
  }

  return {
    ...normalized,
    // Preserve a future/upstream multi-round-trip discriminator.
    resultType:
      normalized.resultType === 'input_required' ? 'input_required' : 'complete',
    _meta: {
      ...existingMeta,
      [SERVER_INFO_META_KEY]: serverInfo,
    },
  } as unknown as MCPackResult;
}

function normalizeValue(value: unknown): Record<string, unknown> {
  if (value == null) {
    return { content: [{ type: 'text', text: '' }] };
  }
  if (typeof value === 'string') {
    return { content: [{ type: 'text', text: value }] };
  }
  if (
    isRecord(value) &&
    (
      Array.isArray(value.content) ||
      Array.isArray(value.tools) ||
      value.resultType === 'input_required'
    )
  ) {
    return value;
  }
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
