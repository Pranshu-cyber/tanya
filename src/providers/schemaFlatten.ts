import type { ToolDefinition } from "./types";

export type SchemaFlattenWarning = {
  path: string;
  reason: string;
  tool?: string;
};

export type SchemaFlattenResult<T> = {
  schema: T;
  warnings: SchemaFlattenWarning[];
};

type JsonObject = Record<string, unknown>;

export function flattenJsonSchema<T>(schema: T): SchemaFlattenResult<T> {
  const warnings: SchemaFlattenWarning[] = [];
  const root = clone(schema);
  const flattened = flattenValue(root, root, "#", warnings, new Set()) as T;
  return { schema: flattened, warnings };
}

export function flattenToolDefinition(tool: ToolDefinition): SchemaFlattenResult<ToolDefinition> {
  const result = flattenJsonSchema(tool.function.parameters);
  return {
    schema: {
      ...tool,
      function: {
        ...tool.function,
        parameters: result.schema,
      },
    },
    warnings: result.warnings.map((warning) => ({ ...warning, tool: tool.function.name })),
  };
}

export function flattenToolDefinitions(tools: ToolDefinition[]): SchemaFlattenResult<ToolDefinition[]> {
  const flattened: ToolDefinition[] = [];
  const warnings: SchemaFlattenWarning[] = [];
  for (const tool of tools) {
    const result = flattenToolDefinition(tool);
    flattened.push(result.schema);
    warnings.push(...result.warnings);
  }
  return { schema: flattened, warnings };
}

function flattenValue(
  value: unknown,
  root: unknown,
  path: string,
  warnings: SchemaFlattenWarning[],
  seenRefs: Set<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => flattenValue(item, root, `${path}/${index}`, warnings, seenRefs));
  }
  if (!isObject(value)) return value;

  const ref = typeof value.$ref === "string" ? value.$ref : null;
  if (ref) {
    const resolved = resolveLocalRef(root, ref);
    if (resolved === undefined) {
      warnings.push({ path, reason: `unresolved $ref ${ref}; leaving reference in place` });
      return value;
    }
    if (seenRefs.has(ref)) {
      warnings.push({ path, reason: `circular $ref ${ref}; leaving reference in place` });
      return value;
    }
    warnings.push({ path, reason: `inlined $ref ${ref}` });
    seenRefs.add(ref);
    const flattened = flattenValue(resolved, root, path, warnings, seenRefs);
    seenRefs.delete(ref);
    const { $ref: _ref, ...overrides } = value;
    return isObject(flattened)
      ? flattenObject({ ...flattened, ...overrides }, root, path, warnings, seenRefs)
      : flattened;
  }

  return flattenObject(value, root, path, warnings, seenRefs);
}

function flattenObject(
  object: JsonObject,
  root: unknown,
  path: string,
  warnings: SchemaFlattenWarning[],
  seenRefs: Set<string>,
): JsonObject {
  const withoutDefs = stripDefinitions(object);
  if (Array.isArray(withoutDefs.oneOf)) {
    return flattenOneOf(withoutDefs, root, path, warnings, seenRefs);
  }

  const output: JsonObject = {};
  for (const [key, raw] of Object.entries(withoutDefs)) {
    output[key] = flattenValue(raw, root, `${path}/${escapePointer(key)}`, warnings, seenRefs);
  }
  return output;
}

function flattenOneOf(
  object: JsonObject,
  root: unknown,
  path: string,
  warnings: SchemaFlattenWarning[],
  seenRefs: Set<string>,
): JsonObject {
  const variants = object.oneOf as unknown[];
  const flattenedVariants = variants
    .map((variant, index) => flattenValue(variant, root, `${path}/oneOf/${index}`, warnings, seenRefs))
    .filter(isObject);
  if (flattenedVariants.length === 0) {
    warnings.push({ path, reason: "oneOf had no object variants; dropped oneOf" });
    const { oneOf: _oneOf, ...rest } = object;
    return flattenObject(rest, root, path, warnings, seenRefs);
  }

  const commonType = commonScalar(flattenedVariants.map((variant) => variant.type));
  const commonProperties = commonObjectProperties(flattenedVariants);
  const commonRequired = commonRequiredFields(flattenedVariants);
  const { oneOf: _oneOf, ...rest } = object;
  warnings.push({ path, reason: `collapsed oneOf (${variants.length} variants) to common object shape` });

  return flattenObject({
    ...rest,
    ...(commonType ? { type: commonType } : {}),
    ...(Object.keys(commonProperties).length ? { properties: commonProperties } : {}),
    ...(commonRequired.length ? { required: commonRequired } : {}),
  }, root, path, warnings, seenRefs);
}

function commonObjectProperties(variants: JsonObject[]): JsonObject {
  const propertyMaps = variants
    .map((variant) => isObject(variant.properties) ? variant.properties : {});
  if (propertyMaps.length === 0) return {};
  const commonKeys = Object.keys(propertyMaps[0] ?? {})
    .filter((key) => propertyMaps.every((properties) => key in properties));
  const output: JsonObject = {};
  for (const key of commonKeys) output[key] = propertyMaps[0]?.[key];
  return output;
}

function commonRequiredFields(variants: JsonObject[]): string[] {
  const requiredLists = variants
    .map((variant) => Array.isArray(variant.required) ? variant.required.filter((item): item is string => typeof item === "string") : []);
  if (requiredLists.length === 0) return [];
  return requiredLists[0]?.filter((key) => requiredLists.every((list) => list.includes(key))) ?? [];
}

function commonScalar(values: unknown[]): string | null {
  const [first] = values;
  return typeof first === "string" && values.every((value) => value === first) ? first : null;
}

function resolveLocalRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref.slice(2).split("/").map(unescapePointer);
  let current = root;
  for (const part of parts) {
    if (!isObject(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stripDefinitions(object: JsonObject): JsonObject {
  const { $defs: _defs, definitions: _definitions, ...rest } = object;
  return rest;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapePointer(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}
