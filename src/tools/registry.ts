import { z } from 'zod';
import { customersGetTool } from './implementations/customers-get.js';
import { refundsExecuteTool } from './implementations/refunds-execute.js';
import { ticketsSearchTool } from './implementations/tickets-search.js';
import type { MockTool } from './types.js';

export interface ToolExecutor {
  validate?(
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): void;
  execute(
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown>;
}

export class UnknownToolError extends Error {
  constructor(toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = 'UnknownToolError';
  }
}

export class ToolArgumentValidationError extends Error {
  readonly issues: Array<{ path: string; message: string }>;

  constructor(error: z.ZodError) {
    super('Invalid tool arguments.');
    this.name = 'ToolArgumentValidationError';
    this.issues = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
  }
}

export class ToolRegistry implements ToolExecutor {
  private readonly tools: ReadonlyMap<string, MockTool>;

  constructor(tools: readonly MockTool[]) {
    const entries = new Map<string, MockTool>();

    for (const tool of tools) {
      if (entries.has(tool.name)) {
        throw new Error(`Duplicate mock tool: ${tool.name}`);
      }

      entries.set(tool.name, tool);
    }

    this.tools = entries;
  }

  validate(
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): void {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new UnknownToolError(toolName);
    }

    try {
      tool.validate(argumentsValue);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ToolArgumentValidationError(error);
      }

      throw error;
    }
  }

  async execute(
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<unknown> {
    this.validate(toolName, argumentsValue);
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new UnknownToolError(toolName);
    }
    return await tool.execute(argumentsValue);
  }
}

export const defaultToolRegistry = new ToolRegistry([
  ticketsSearchTool,
  customersGetTool,
  refundsExecuteTool,
]);
