import {
  defaultToolRegistry,
  UnknownToolError,
  type ToolExecutor,
} from './registry.js';

export class RoutingToolExecutor implements ToolExecutor {
  constructor(
    private readonly tickets: ToolExecutor,
    private readonly mock: ToolExecutor = defaultToolRegistry,
  ) {}

  private route(name: string): ToolExecutor {
    if (name === 'tickets.search') return this.tickets;
    if (name === 'refunds.execute' || name === 'customers.get')
      return this.mock;
    throw new UnknownToolError(name);
  }

  validate(name: string, args: Record<string, unknown>): void {
    this.route(name).validate?.(name, args);
  }

  execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.route(name).execute(name, args);
  }
}
