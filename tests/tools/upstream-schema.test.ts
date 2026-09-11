import { afterEach, expect, it, vi } from 'vitest';
import * as schemaLibrary from '@cfworker/json-schema';
import {
  compileTicketSchema,
  formatKeywordDiagnostic,
} from '../../src/tools/upstream-schema.js';
import { MCPToolExecutor } from '../../src/tools/mcp-tool-executor.js';
import { runRealMCPDemo } from '../../src/demo/real-mcp-diagnostics.js';
import { FakeUpstream, tool } from './fake-upstream.js';

const construction = vi.hoisted(() => ({
  fail: false,
  schemas: [] as unknown[],
}));
vi.mock('@cfworker/json-schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cfworker/json-schema')>();
  return {
    ...actual,
    Validator: class extends actual.Validator {
      constructor(...args: ConstructorParameters<typeof actual.Validator>) {
        if (construction.fail) throw new Error('token-secret upstream-message');
        construction.schemas.push(structuredClone(args[0]));
        super(...args);
      }
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  construction.fail = false;
  construction.schemas = [];
});
const secret =
  'token-secret raw-schema-description header-secret upstream-message stack-secret';

function annotatedSchema(value: unknown) {
  return {
    ...tool().inputSchema,
    properties: {
      query: { type: 'string', minLength: 1 },
      optionalInput: {
        type: 'string',
        minLength: 3,
        enum: ['valid'],
        'x-mcp-header': value,
      },
    },
  };
}

it.each(['X-MCP-Test', 'Authorization', 'a', '-', '9', 'A'.repeat(64)])(
  'removes only the admitted annotation from the clone, case %#',
  (value) => {
    const source = annotatedSchema(value);
    const original = structuredClone(source);
    const observer = vi.fn();
    const validator = compileTicketSchema(source, observer);
    const expected = {
      ...source,
      properties: {
        ...source.properties,
        optionalInput: { type: 'string', minLength: 3, enum: ['valid'] },
      },
    };
    expect(construction.schemas).toEqual([expected]);
    expect(source).toEqual(original);
    expect(observer).not.toHaveBeenCalled();
    expect(validator.validate({ query: 'test' }).valid).toBe(true);
    expect(
      validator.validate({ query: 'test', optionalInput: 'valid' }).valid,
    ).toBe(true);
    expect(
      validator.validate({ query: 'test', optionalInput: 'x' }).valid,
    ).toBe(false);
    expect(
      validator.validate({ query: 'test', unexpected: 'valid' }).valid,
    ).toBe(false);
  },
);

it.each([
  true,
  1,
  {},
  [],
  null,
  undefined,
  '',
  'A'.repeat(65),
  'X_Header',
  'X Header',
  'X:Header',
  'X/Header',
  'X.Header',
  '$Header',
  'é',
  'X\n',
  'X\r',
  'X\t',
  'X\0',
])(
  'rejects invalid annotation values without constructing a validator, case %#',
  (value) => {
    expect(() => compileTicketSchema(annotatedSchema(value))).toThrow(
      'Read-only MCP integration failed.',
    );
    expect(construction.schemas).toHaveLength(0);
  },
);

it.each(['root', 'query', 'items', 'nested'])(
  'rejects a valid header name in a forbidden location, case %#',
  (location) => {
    const extension = { type: 'string', 'x-mcp-header': 'X-Test' };
    const base = tool().inputSchema;
    const source =
      location === 'root'
        ? { ...base, 'x-mcp-header': 'X-Test' }
        : {
            ...base,
            properties:
              location === 'query'
                ? { query: extension }
                : {
                    query: { type: 'string' },
                    optionalInput:
                      location === 'items'
                        ? { type: 'array', items: extension }
                        : { type: 'object', properties: { child: extension } },
                  },
          };
    expect(() => compileTicketSchema(source)).toThrow(
      'Read-only MCP integration failed.',
    );
    expect(construction.schemas).toHaveLength(0);
  },
);

it('retains required annotated properties and fails the query-only startup fixture', () => {
  const observer = vi.fn();
  const source = {
    ...annotatedSchema('X-Test'),
    required: ['query', 'optionalInput'],
  };
  expect(() => compileTicketSchema(source, observer)).toThrow(
    'Read-only MCP integration failed.',
  );
  expect(construction.schemas[0]).toMatchObject({
    required: ['query', 'optionalInput'],
    properties: { optionalInput: { type: 'string' } },
  });
  expect(observer.mock.calls).toEqual([['fixture_validation_failed']]);
});

it.each(['customKeyword', '$ref', '$dynamicRef'])(
  'still rejects other unknown keywords and references, case %#',
  (key) => {
    const source = annotatedSchema('X-Test');
    const schema = {
      ...source,
      properties: {
        ...source.properties,
        optionalInput: { ...source.properties.optionalInput, [key]: secret },
      },
    };
    expect(() => compileTicketSchema(schema)).toThrow(
      'Read-only MCP integration failed.',
    );
    expect(construction.schemas).toHaveLength(0);
  },
);

it.each(['__proto__', 'constructor', 'toString'])(
  'rejects unusual root keys, case %#',
  (key) => {
    const observer = vi.fn();
    expect(() =>
      compileTicketSchema({ ...tool().inputSchema, [key]: secret }, observer),
    ).toThrow('Read-only MCP integration failed.');
    expect(observer.mock.calls[0][0]).toBe('unsupported_schema_keyword');
    expect(formatKeywordDiagnostic(observer.mock.calls[0][1])).toBe(
      key === '__proto__'
        ? 'unsupported_keyword_other'
        : `unsupported_schema_keyword=${key}`,
    );
  },
);

it.each([
  [{ format: secret, pattern: secret }, 'format'],
  [{ pattern: secret, format: secret }, 'pattern'],
  [{ format: secret, [secret]: true }, 'format'],
  [{ [secret]: true, format: secret }, null],
] as const)(
  'reports only the first unsupported key without searching for a printable one, case %#',
  (keywords, expected) => {
    const observer = vi.fn();
    expect(() =>
      compileTicketSchema(
        {
          ...tool().inputSchema,
          properties: {
            query: { type: 'string' },
            [secret]: { type: 'string', ...keywords },
          },
        },
        observer,
      ),
    ).toThrow('Read-only MCP integration failed.');
    expect(observer.mock.calls).toHaveLength(1);
    expect(formatKeywordDiagnostic(observer.mock.calls[0][1])).toBe(
      expected === null
        ? 'unsupported_keyword_other'
        : `unsupported_schema_keyword=${expected}`,
    );
  },
);

it('does not mistake a property name for an unsupported keyword', () => {
  const observer = vi.fn();
  compileTicketSchema(
    {
      ...tool().inputSchema,
      properties: { query: { type: 'string' }, pattern: { type: 'string' } },
    },
    observer,
  );
  expect(observer).not.toHaveBeenCalled();
});

it.each([
  'SafePropertyName',
  'pattern',
  'x'.repeat(100),
  '属性',
  'name\nsecret',
  secret,
])(
  'never reports a property name while descending through its schema, case %#',
  (name) => {
    const observer = vi.fn();
    expect(() =>
      compileTicketSchema(
        {
          ...tool().inputSchema,
          properties: {
            query: { type: 'string' },
            [name]: {
              type: 'array',
              items: { type: 'string', customKeyword: secret },
            },
          },
        },
        observer,
      ),
    ).toThrow('Read-only MCP integration failed.');
    expect(formatKeywordDiagnostic(observer.mock.calls[0][1])).toBe(
      'unsupported_schema_keyword=customKeyword',
    );
  },
);

it('uses depth-first encounter order, without inspecting schema values', () => {
  const observer = vi.fn();
  expect(() =>
    compileTicketSchema(
      {
        ...tool().inputSchema,
        properties: {
          query: { type: 'string', nestedFirst: { valueKeyword: secret } },
        },
        rootLater: secret,
      },
      observer,
    ),
  ).toThrow('Read-only MCP integration failed.');
  expect(formatKeywordDiagnostic(observer.mock.calls[0][1])).toBe(
    'unsupported_schema_keyword=nestedFirst',
  );
});

it('rejects bare strings and objects without schema-key provenance', () => {
  for (const value of [
    'pattern',
    { keyword: 'pattern' },
    { keyword: 'pattern', schemaKeywordOrigin: true },
  ]) {
    expect(formatKeywordDiagnostic(value)).toBe('unsupported_keyword_other');
  }
});

it.each([
  ['unsupported_schema_dialect', { ...tool().inputSchema, $schema: secret }],
  ['unsupported_keyword_other', { ...tool().inputSchema, [secret]: true }],
  ['unsupported_schema_keyword=$ref', { ...tool().inputSchema, $ref: secret }],
  [
    'unsupported_schema_keyword=$ref',
    {
      ...tool().inputSchema,
      properties: { query: { type: 'string', $ref: secret } },
    },
  ],
  ['unsupported_schema_value_type', { ...tool().inputSchema, minimum: secret }],
  [
    'unsupported_schema_value_type',
    {
      ...tool().inputSchema,
      properties: {
        query: { type: 'string' },
        hiddenSecretProperty: { type: [secret] },
      },
    },
  ],
  [
    'query_property_missing',
    {
      ...tool().inputSchema,
      properties: { hiddenSecretProperty: { type: 'string' } },
    },
  ],
  [
    'query_property_not_string',
    {
      ...tool().inputSchema,
      properties: { query: { type: 'number', description: secret } },
    },
  ],
  [
    'query_property_not_string',
    { ...tool().inputSchema, properties: { query: { description: secret } } },
  ],
  ['query_not_required', { ...tool().inputSchema, required: [] }],
  [
    'fixture_validation_failed',
    {
      ...tool().inputSchema,
      properties: { query: { type: 'string', maxLength: 1 } },
    },
  ],
  ['schema_validation_other', { ...tool().inputSchema, minItems: -1 }],
] as const)(
  'reports only the schema category for case %#',
  async (category, inputSchema) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const peer = new FakeUpstream();
    peer.catalog = { tools: [{ ...tool(), description: secret, inputSchema }] };
    const outcome = await runRealMCPDemo({
      connect: (observer) => MCPToolExecutor.connect(peer, 1000, observer),
    });
    expect(outcome).toEqual({ exitCode: 1, message: category });
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(peer.calls()).toHaveLength(0);
    expect(peer.closed).toBe(true);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  },
);

it('reports constructor failures with no raw exception data', async () => {
  construction.fail = true;
  const peer = new FakeUpstream();
  expect(
    await runRealMCPDemo({
      connect: (observer) => MCPToolExecutor.connect(peer, 1000, observer),
    }),
  ).toEqual({ exitCode: 1, message: 'schema_validator_construction_failed' });
});

it.each(['throw', 'accept_invalid', 'reject_valid'])(
  'checks all fixture outcomes: %s',
  (mode) => {
    const observer = vi.fn();
    vi.spyOn(schemaLibrary.Validator.prototype, 'validate').mockImplementation(
      () => {
        if (mode === 'throw') throw new Error(secret);
        return { valid: mode === 'accept_invalid', errors: [] };
      },
    );
    expect(() => compileTicketSchema(tool().inputSchema, observer)).toThrow(
      'Read-only MCP integration failed.',
    );
    expect(observer.mock.calls).toEqual([['fixture_validation_failed']]);
  },
);

it('keeps the normal error generic and ignores observer failures', () => {
  expect(() =>
    compileTicketSchema({ ...tool().inputSchema, $ref: secret }, () => {
      throw new Error(secret);
    }),
  ).toThrow('Read-only MCP integration failed.');
});

it.each([
  'https://json-schema.org/draft/2020-12/schema',
  'http://json-schema.org/draft-07/schema#',
])('preserves admitted dialect case %# and cached validation', (dialect) => {
  const schema = { ...tool().inputSchema, $schema: dialect };
  const validator = compileTicketSchema(schema);
  schema.properties.query.minLength = 9999;
  expect(validator.validate({ query: 'test' }).valid).toBe(true);
  expect(validator.validate({ query: 1 }).valid).toBe(false);
  expect(
    validator.validate({ query: 'test', hiddenSecretProperty: secret }).valid,
  ).toBe(false);
});

it.each(['text', 1, true, null, ['text', 1, false]])(
  'models existing defaults explicitly, case %#',
  (value) => {
    const validator = compileTicketSchema({
      ...tool().inputSchema,
      default: value,
    });
    expect(validator.validate({}).valid).toBe(false); // Defaults never insert query.
    expect(validator.validate({ query: 'test' }).valid).toBe(true);
  },
);

it.each([
  { nested: secret },
  Array(129).fill('x'),
  'x'.repeat(16385),
  Infinity,
])('rejects unbounded default values, case %#', (value) => {
  expect(() =>
    compileTicketSchema({ ...tool().inputSchema, default: value }),
  ).toThrow('Read-only MCP integration failed.');
});

it.each([
  { properties: [] },
  { required: 'query' },
  { type: 'array' },
  { properties: { query: { type: 'string' } }, required: ['query', 'query'] },
  { properties: { query: { type: 'string' } }, additionalProperties: {} },
])('rejects malformed schema structures, case %#', (patch) => {
  expect(() =>
    compileTicketSchema({ ...tool().inputSchema, ...patch }),
  ).toThrow('Read-only MCP integration failed.');
});
