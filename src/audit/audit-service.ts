import { randomUUID } from 'node:crypto';
import type { AuditEvent, AuditEventInput, AuditSink } from './types.js';
import { sanitizeAuditData, sanitizeAuditResult } from './sanitize.js';

export interface AuditServiceOptions {
  sink: AuditSink;
  now: () => Date;
  generateEventId: () => string;
}

export class AuditService {
  private readonly options: AuditServiceOptions;

  constructor(options: AuditServiceOptions) {
    this.options = options;
  }

  async emit(input: AuditEventInput): Promise<void> {
    const event: AuditEvent = {
      ...input,
      ...(input.sanitizedArguments
        ? {
            sanitizedArguments: sanitizeAuditData(
              input.sanitizedArguments,
            ),
          }
        : {}),
      ...('resultSummary' in input
        ? { resultSummary: sanitizeAuditResult(input.resultSummary) }
        : {}),
      eventId: this.options.generateEventId(),
      timestamp: this.options.now().toISOString(),
    };
    await this.options.sink.emit(event);
  }
}

export function createAuditService(sink: AuditSink): AuditService {
  return new AuditService({
    sink,
    now: () => new Date(),
    generateEventId: () => `event-${randomUUID()}`,
  });
}
