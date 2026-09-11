import { Validator, type Schema } from '@cfworker/json-schema';
import { z } from 'zod';

// Only this module can mark a diagnostic as originating from a schema key.
const schemaKeywordOrigin = Symbol('schema-keyword-origin');
const headerLocations = [
  'schema_root',
  'query_property_schema',
  'other_property_schema',
  'array_item_schema',
  'nested_schema',
] as const;
const jsonTypes = [
  'boolean',
  'string',
  'number',
  'object',
  'array',
  'null',
] as const;
type HeaderLocation = (typeof headerLocations)[number];
type JSONValueType = (typeof jsonTypes)[number];
interface UnsupportedSchemaKey {
  keyword: string;
  location?: HeaderLocation;
  valueType?: JSONValueType;
}
export type KeywordDiagnostic =
  | Readonly<{
      [schemaKeywordOrigin]: true;
      keyword: string;
      location?: HeaderLocation;
      valueType?: JSONValueType;
    }>
  | 'unsupported_keyword_other';

function safeKeyword(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Full-match equality also rejects a trailing newline (JavaScript $ semantics).
  const match = /^\$?[A-Za-z][A-Za-z0-9_-]{0,31}$/.exec(value);
  return match !== null && match[0] === value;
}

function unsupportedKeyword(
  keys: readonly UnsupportedSchemaKey[],
): KeywordDiagnostic {
  const first = keys[0];
  return first && safeKeyword(first.keyword)
    ? Object.freeze({ [schemaKeywordOrigin]: true as const, ...first })
    : 'unsupported_keyword_other';
}

/** Demo formatter: never accepts a bare string or an unprovenanced property name. */
export function formatKeywordDiagnostic(value: unknown): string {
  if (
    value !== null &&
    typeof value === 'object' &&
    schemaKeywordOrigin in value &&
    value[schemaKeywordOrigin] === true &&
    'keyword' in value &&
    safeKeyword(value.keyword)
  ) {
    if (value.keyword === 'x-mcp-header') {
      if (
        'location' in value &&
        'valueType' in value &&
        headerLocations.some((location) => location === value.location) &&
        jsonTypes.some((type) => type === value.valueType)
      ) {
        return `x_mcp_header_location=${value.location}\nx_mcp_header_value_type=${value.valueType}`;
      }
      return 'unsupported_keyword_other';
    }
    return 'unsupported_schema_keyword=' + value.keyword;
  }
  return 'unsupported_keyword_other';
}

export type SchemaFailureStage =
  | 'unsupported_schema_dialect'
  | 'unsupported_schema_keyword'
  | 'unsupported_schema_value_type'
  | 'query_property_missing'
  | 'query_property_not_string'
  | 'query_not_required'
  | 'fixture_validation_failed'
  | 'schema_validator_construction_failed'
  | 'schema_validation_other';

// Explicit bounded vocabulary. No references, catchall or unknown-key passthrough.
const scalar = z.union([
  z.string().max(16384),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const schemaNode: z.ZodLazy<z.AnyZodObject> = z.lazy(() =>
  z
    .object({
      $schema: z
        .enum([
          'https://json-schema.org/draft/2020-12/schema',
          'http://json-schema.org/draft-07/schema#',
        ])
        .optional(),
      type: z.enum([
        'object',
        'array',
        'string',
        'integer',
        'number',
        'boolean',
        'null',
      ]),
      title: z.string().optional(),
      description: z.string().optional(),
      // Defaults are annotations, never applied. Reject arbitrary object defaults.
      default: z.union([scalar, z.array(scalar).max(128)]).optional(),
      properties: z.record(schemaNode).optional(),
      required: z
        .array(z.string())
        .refine((v) => new Set(v).size === v.length)
        .optional(),
      additionalProperties: z.boolean().optional(),
      items: schemaNode.optional(),
      enum: z
        .array(
          z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
        )
        .nonempty()
        .optional(),
      minimum: z.number().finite().optional(),
      maximum: z.number().finite().optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
      uniqueItems: z.boolean().optional(),
    })
    .strict(),
);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Upstream annotation only. Its value never enters any HTTP header operation.
const headerNameAnnotation = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => /^[A-Za-z0-9-]{1,64}$/.exec(value)?.[0] === value);

function removeAdmittedHeaderAnnotations(
  schema: Record<string, unknown>,
): void {
  if (!record(schema.properties)) return;
  for (const [name, propertySchema] of Object.entries(schema.properties)) {
    if (
      name !== 'query' &&
      record(propertySchema) &&
      Object.hasOwn(propertySchema, 'x-mcp-header') &&
      headerNameAnnotation.safeParse(propertySchema['x-mcp-header']).success
    ) {
      // Only the cloned direct property annotation is removed. Invalid values
      // and all other locations remain present and fail strict validation.
      delete propertySchema['x-mcp-header'];
    }
  }
}

// Derive permitted keywords from the strict model, not from diagnostic names.
const modeledKeywords = new Set(Object.keys(schemaNode.schema.shape));
function jsonValueType(value: unknown): JSONValueType | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number')
    return Number.isFinite(value) ? 'number' : undefined;
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'object'
  )
    return typeof value as JSONValueType;
  return undefined;
}

function unrecognizedSchemaKeys(
  node: unknown,
  location: HeaderLocation = 'schema_root',
  diagnostics = false,
): UnsupportedSchemaKey[] {
  if (!record(node)) return [];
  // Depth-first encounter order. Stop at the first unsupported schema key.
  for (const key of Object.keys(node)) {
    if (!modeledKeywords.has(key))
      return [
        {
          keyword: key,
          ...(diagnostics && key === 'x-mcp-header'
            ? { location, valueType: jsonValueType(node[key]) }
            : {}),
        },
      ];
    // Traverse property schemas, never the property names themselves.
    if (key === 'properties' && record(node.properties)) {
      for (const [name, child] of Object.entries(node.properties)) {
        const childLocation =
          location === 'schema_root'
            ? name === 'query'
              ? 'query_property_schema'
              : 'other_property_schema'
            : 'nested_schema';
        const keys = unrecognizedSchemaKeys(child, childLocation, diagnostics);
        if (keys.length) return keys;
      }
    }
    if (key === 'items') {
      const keys = unrecognizedSchemaKeys(
        node.items,
        'array_item_schema',
        diagnostics,
      );
      if (keys.length) return keys;
    }
  }
  return [];
}

function syntaxFailure(error: z.ZodError): SchemaFailureStage {
  // Inspect local validation codes/paths only; never forward issues or messages.
  if (error.issues.some((issue) => issue.path.at(-1) === '$schema'))
    return 'unsupported_schema_dialect';
  if (error.issues.some((issue) => issue.code === 'unrecognized_keys'))
    return 'unsupported_schema_keyword';
  if (
    error.issues.some((issue) =>
      ['invalid_type', 'invalid_enum_value', 'invalid_union'].includes(
        issue.code,
      ),
    )
  )
    return 'unsupported_schema_value_type';
  return 'schema_validation_other';
}

/** Same generic error externally; the optional demo observer receives constants only. */
export function compileTicketSchema(
  value: unknown,
  observer?: (stage: SchemaFailureStage, keyword?: KeywordDiagnostic) => void,
): Validator {
  let stage: SchemaFailureStage = 'schema_validation_other';
  let keyword: KeywordDiagnostic | undefined;
  try {
    const schema: unknown = structuredClone(value);
    if (!record(schema) || schema.type !== 'object') throw new Error();
    if (schema.properties !== undefined && !record(schema.properties)) {
      stage = 'unsupported_schema_value_type';
      throw new Error();
    }
    if (
      !record(schema.properties) ||
      !Object.hasOwn(schema.properties, 'query')
    ) {
      stage = 'query_property_missing';
      throw new Error();
    }
    if (
      !record(schema.properties.query) ||
      schema.properties.query.type !== 'string'
    ) {
      stage = 'query_property_not_string';
      throw new Error();
    }
    if (schema.required !== undefined && !Array.isArray(schema.required)) {
      stage = 'unsupported_schema_value_type';
      throw new Error();
    }
    if (!Array.isArray(schema.required) || !schema.required.includes('query')) {
      stage = 'query_not_required';
      throw new Error();
    }
    removeAdmittedHeaderAnnotations(schema);
    const parsed = schemaNode.safeParse(schema);
    const keys = unrecognizedSchemaKeys(
      schema,
      'schema_root',
      observer !== undefined,
    );
    if (!parsed.success || keys.length > 0) {
      stage = parsed.success
        ? 'unsupported_schema_keyword'
        : syntaxFailure(parsed.error);
      if (keys.length > 0 && stage !== 'unsupported_schema_dialect')
        stage = 'unsupported_schema_keyword';
      if (observer && stage === 'unsupported_schema_keyword')
        keyword = unsupportedKeyword(keys);
      throw new Error();
    }
    stage = 'schema_validator_construction_failed';
    const validator = new Validator(schema as Schema, '2020-12');
    stage = 'fixture_validation_failed';
    if (
      !validator.validate({ query: 'repo:github/github-mcp-server is:issue' })
        .valid ||
      validator.validate({}).valid ||
      validator.validate({ query: 1 }).valid
    )
      throw new Error();
    return validator;
  } catch {
    try {
      if (keyword === undefined) observer?.(stage);
      else observer?.(stage, keyword);
    } catch {
      /* Diagnostics cannot change fail-closed behavior. */
    }
    throw new Error('Read-only MCP integration failed.');
  }
}
