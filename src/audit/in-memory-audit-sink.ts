import type { AuditEvent, AuditSink } from './types.js';

export class InMemoryAuditSink implements AuditSink {
  private readonly events: AuditEvent[] = [];

  async emit(event: AuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  getEvents(): readonly AuditEvent[] {
    return structuredClone(this.events);
  }

  clear(): void {
    this.events.length = 0;
  }
}
