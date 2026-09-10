import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  UnsupportedProtocolVersionError,
  type ClientCapabilities,
  type Implementation,
  type ServerContext,
} from '@modelcontextprotocol/server';

export const SUPPORTED_MCP_PROTOCOL_VERSION = '2026-07-28' as const;
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = [
  SUPPORTED_MCP_PROTOCOL_VERSION,
] as const;

export interface MCPackRequestProtocolContext {
  protocolVersion: string;
  clientCapabilities: ClientCapabilities;
  /** Self-reported attribution only. Never use this value for authorization. */
  clientInfo?: Implementation;
}

export class MissingMCPRequestMetadataError extends Error {
  constructor(public readonly field: 'protocolVersion' | 'clientCapabilities') {
    super(`Missing required MCP request metadata: ${field}`);
    this.name = 'MissingMCPRequestMetadataError';
  }
}

export function validateMCPRequestMetadata(
  envelope: unknown,
): MCPackRequestProtocolContext {
  const meta = isRecord(envelope) ? envelope : {};
  const protocolVersion = meta[PROTOCOL_VERSION_META_KEY];
  const clientCapabilities = meta[CLIENT_CAPABILITIES_META_KEY];
  const clientInfo = meta[CLIENT_INFO_META_KEY];

  if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) {
    throw new MissingMCPRequestMetadataError('protocolVersion');
  }
  if (protocolVersion !== SUPPORTED_MCP_PROTOCOL_VERSION) {
    throw new UnsupportedProtocolVersionError({
      requested: protocolVersion,
      supported: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
    });
  }
  if (!isRecord(clientCapabilities)) {
    throw new MissingMCPRequestMetadataError('clientCapabilities');
  }
  if (clientInfo !== undefined && !isImplementation(clientInfo)) {
    throw new TypeError('Invalid MCP clientInfo metadata');
  }

  return {
    protocolVersion,
    clientCapabilities: clientCapabilities as ClientCapabilities,
    ...(clientInfo === undefined ? {} : { clientInfo }),
  };
}

export function protocolContextFromServerContext(
  context: ServerContext,
): MCPackRequestProtocolContext {
  return validateMCPRequestMetadata(context.mcpReq.envelope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImplementation(value: unknown): value is Implementation {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.version === 'string'
  );
}
