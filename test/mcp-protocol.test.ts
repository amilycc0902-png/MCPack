import { describe, expect, it } from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import {
  MissingMCPRequestMetadataError,
  validateMCPRequestMetadata,
} from '../src/mcp/protocol.js';
import { normalizeMCPResult } from '../src/mcp/result.js';

describe('central MCP protocol boundary', () => {
  it('validates required metadata and accepts optional clientInfo', () => {
    expect(validateMCPRequestMetadata({
      [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
      [CLIENT_CAPABILITIES_META_KEY]: { tools: {} },
      [CLIENT_INFO_META_KEY]: { name: 'client', version: '1' },
    })).toEqual({
      protocolVersion: '2026-07-28',
      clientCapabilities: { tools: {} },
      clientInfo: { name: 'client', version: '1' },
    });
  });

  it('rejects missing metadata and unsupported versions centrally', () => {
    expect(() => validateMCPRequestMetadata({})).toThrow(
      MissingMCPRequestMetadataError,
    );
    try {
      validateMCPRequestMetadata({
        [PROTOCOL_VERSION_META_KEY]: '2025-11-25',
        [CLIENT_CAPABILITIES_META_KEY]: {},
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe(
        ProtocolErrorCode.UnsupportedProtocolVersion,
      );
    }
  });
});

describe('central MCP result normalization', () => {
  it('preserves upstream metadata and input_required', () => {
    const result = normalizeMCPResult({
      content: [],
      resultType: 'input_required',
      inputRequests: { confirm: { type: 'elicitation' } },
      _meta: { upstream: true },
    }, { name: 'server', version: '1' });

    expect(result.resultType).toBe('input_required');
    expect(result._meta.upstream).toBe(true);
    expect(result._meta['io.modelcontextprotocol/serverInfo']).toEqual({
      name: 'server', version: '1',
    });
  });

  it('rejects a conflicting upstream server identity instead of overwriting it', () => {
    expect(() => normalizeMCPResult({
      content: [],
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: 'other', version: '1' },
      },
    }, { name: 'server', version: '1' })).toThrow('server identity conflicts');
  });
});
