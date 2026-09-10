import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { customersGetTool } from '../../src/tools/implementations/customers-get.js';
import { refundsExecuteTool } from '../../src/tools/implementations/refunds-execute.js';

describe('mock tool registry', () => {
  it('returns deterministic customer data', async () => {
    const registry = new ToolRegistry([customersGetTool]);

    await expect(
      registry.execute('customers.get', {
        customerId: 'customer-001',
      }),
    ).resolves.toEqual({
      customerId: 'customer-001',
      name: 'Example Customer',
      email: 'customer@example.test',
      accountStatus: 'active',
    });
  });

  it('simulates a refund deterministically without an external side effect', async () => {
    const registry = new ToolRegistry([refundsExecuteTool]);
    const argumentsValue = {
      customerId: 'customer-001',
      amount: 50,
      reason: 'Duplicate charge',
    };

    const firstResult = await registry.execute(
      'refunds.execute',
      argumentsValue,
    );
    const secondResult = await registry.execute(
      'refunds.execute',
      argumentsValue,
    );

    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toMatchObject({
      status: 'simulated',
      amount: 50,
    });
  });
});
