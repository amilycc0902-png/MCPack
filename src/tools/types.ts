import { z } from 'zod';

export interface MockTool {
  name: string;
  validate(argumentsValue: Record<string, unknown>): void;
  execute(argumentsValue: Record<string, unknown>): unknown;
}

export function defineMockTool<TSchema extends z.ZodTypeAny, TOutput>(
  name: string,
  schema: TSchema,
  execute: (input: z.infer<TSchema>) => TOutput,
): MockTool {
  return {
    name,
    validate(argumentsValue) {
      schema.parse(argumentsValue);
    },
    execute(argumentsValue) {
      const input = schema.parse(argumentsValue);
      return execute(input);
    },
  };
}
