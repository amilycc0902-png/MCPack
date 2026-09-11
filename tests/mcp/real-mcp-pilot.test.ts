import { expect, it } from 'vitest';
import { createRealMCPPilot } from '../../src/demo/real-mcp-composition.js';
import { MCPToolExecutor } from '../../src/tools/mcp-tool-executor.js';
import { FakeUpstream } from '../tools/fake-upstream.js';
import { buildApp } from '../../src/app.js';
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';

const request = {
  requestId: 'pilot',
  userId: 'support-1',
  userRole: 'support-agent',
  agentId: 'support-agent-1',
  toolName: 'tickets.search',
  arguments: { query: 'test' },
};
it('preserves downstream stateless MCP mapping and policy denial', async () => {
  const peer = new FakeUpstream();
  const upstream = await MCPToolExecutor.connect(peer);
  const pilot = createRealMCPPilot(upstream);
  const call = {
    request: {
      method: 'tools/call' as const,
      params: { name: 'tickets.search', arguments: { query: 'test' } },
    },
    envelope: {
      [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
      [CLIENT_CAPABILITIES_META_KEY]: {},
    },
    mcpRequestId: 'downstream-call',
    identity: {
      userId: 'support-1',
      userRole: 'support-agent',
      agentId: 'support-agent-1',
    },
  };
  const allowed = await pilot.adapter.handle(call);
  expect(allowed.isError).not.toBe(true);
  expect(JSON.stringify(allowed)).toContain('An issue');
  expect(JSON.stringify(allowed)).not.toContain('raw-secret');
  const denied = await pilot.adapter.handle({
    ...call,
    identity: { ...call.identity, userRole: 'unknown' },
  });
  expect(denied.isError).toBe(true);
  expect(peer.calls()).toHaveLength(1);
  await upstream.close();
});
it('integrates real routing with policy, audit, unchanged HTTP and mock approval replay protection', async () => {
  const peer = new FakeUpstream();
  const upstream = await MCPToolExecutor.connect(peer);
  const pilot = createRealMCPPilot(upstream);
  const app = buildApp({
    toolCallService: pilot.toolCallService,
    approvalService: pilot.approvalService,
  });
  try {
    const allowed = await app.inject({
      method: 'POST',
      url: '/v1/tools/call',
      payload: request,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().result.tickets[0].ticketId).toBe('12');
    expect(peer.calls()).toHaveLength(1);
    const denied = await pilot.toolCallService.handle({
      ...request,
      userRole: 'unknown',
    });
    expect(denied.statusCode).toBe(403);
    const refund = {
      ...request,
      requestId: 'refund',
      userRole: 'billing-agent',
      toolName: 'refunds.execute',
      arguments: { customerId: 'customer-1', amount: 10, reason: 'duplicate' },
    };
    const pending = await pilot.toolCallService.handle(refund);
    expect(pending.statusCode).toBe(202);
    const id = String(pending.body.approvalId);
    await pilot.approvalService.approve(id, {
      reviewedBy: 'lead',
      reviewerRole: 'team-lead',
    });
    const executed = await pilot.approvalService.execute(id);
    expect(executed.statusCode).toBe(200);
    expect(executed.body.result).toMatchObject({
      status: 'simulated',
      amount: 10,
    });
    expect((await pilot.approvalService.execute(id)).statusCode).not.toBe(200);
    expect(peer.calls()).toHaveLength(1);
    const audit = JSON.stringify(pilot.sink.getEvents());
    expect(audit).toContain('tool_execution_succeeded');
    expect(audit).not.toContain('raw-secret');
    expect(audit).not.toContain('secret@example.test');
  } finally {
    await app.close();
    await upstream.close();
  }
});

it.each(['rpc', 'connection', 'execution'])(
  'audits %s failure without upstream error or credentials',
  async (mode) => {
    const peer = new FakeUpstream();
    const upstream = await MCPToolExecutor.connect(peer);
    if (mode === 'rpc') peer.rpcError = true;
    if (mode === 'connection') peer.failMethod = 'tools/call';
    if (mode === 'execution')
      peer.result = {
        isError: true,
        content: [{ type: 'text', text: 'Bearer credential-secret' }],
      };
    const pilot = createRealMCPPilot(upstream);
    const response = await pilot.toolCallService.handle(request);
    expect(response.statusCode).toBe(500);
    const evidence = JSON.stringify({
      response,
      events: pilot.sink.getEvents(),
    });
    expect(evidence).toContain('tool_execution_failed');
    expect(evidence).not.toContain('credential-secret');
    expect(evidence).not.toContain('Bearer');
    expect(peer.calls()).toHaveLength(1);
    await upstream.close();
  },
);
