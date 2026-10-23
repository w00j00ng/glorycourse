import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
const sourceFile = resolve(root, 'backend/src/domain/records.ts');
const program = ts.createProgram([sourceFile], options);
const checker = program.getTypeChecker();
const source = program.getSourceFile(sourceFile);
const state = source.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === 'DatabaseState');
if (!state) throw new Error('DatabaseState type is missing');

const union = (values) => {
  const unique = [...new Set(values.flatMap((value) => value.union ?? [value]).map((value) => JSON.stringify(value)))].sort().map((value) => JSON.parse(value));
  return unique.length === 1 ? unique[0] : { union: unique };
};
const literal = (value) => value === null ? { type: 'null' } : { literal: value };
const typeShape = (type, optional = false) => {
  if (type.isUnion()) return union(type.types.filter((item) => !optional || !(item.flags & ts.TypeFlags.Undefined)).map((item) => typeShape(item)));
  if (type.isStringLiteral() || type.isNumberLiteral()) return literal(type.value);
  if (type.flags & ts.TypeFlags.BooleanLiteral) return literal(type.intrinsicName === 'true');
  for (const [flag, name] of [[ts.TypeFlags.String, 'string'], [ts.TypeFlags.Number, 'number'], [ts.TypeFlags.Null, 'null'], [ts.TypeFlags.Undefined, 'undefined'],
    [ts.TypeFlags.Any, 'any'], [ts.TypeFlags.Unknown, 'unknown'], [ts.TypeFlags.Never, 'never'], [ts.TypeFlags.NonPrimitive, 'object']]) {
    if (type.flags & flag) return { type: name };
  }
  if (checker.isTupleType(type)) return { tuple: checker.getTypeArguments(type).map((item) => typeShape(item)) };
  if (checker.isArrayType(type)) return { array: typeShape(checker.getTypeArguments(type)[0]) };
  const properties = Object.fromEntries(checker.getPropertiesOfType(type).map((property) => {
    const optional = Boolean(property.flags & ts.SymbolFlags.Optional);
    return [property.name, { required: !optional, value: typeShape(checker.getTypeOfSymbolAtLocation(property, source), optional) }];
  }).sort(([left], [right]) => left.localeCompare(right)));
  const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  return { properties, ...(index && !(index.flags & ts.TypeFlags.Never) ? { index: typeShape(index) } : {}) };
};

const jsonShape = (value, definitions) => {
  const structuralKeys = ['$ref', 'oneOf', 'allOf', 'type', 'properties', 'required', 'additionalProperties', 'items', 'prefixItems', 'enum', 'const'];
  assert.ok(!('anyOf' in value || 'not' in value), 'Store schema structure differs: unsupported composition');
  assert.ok(!(value.enum && 'const' in value), 'Store schema structure differs: enum and const combination is unsupported');
  const exclusive = value.$ref ? '$ref' : value.oneOf ? 'oneOf' : !value.type && value.allOf ? 'allOf' : null;
  if (exclusive) {
    assert.ok(structuralKeys.every((key) => key === exclusive || !(key in value)),
      `Store schema structure differs: structural siblings of ${exclusive} are unsupported`);
  }
  if (value.type && value.allOf) {
    // Conditional business rules are validated by Ajv; unconditional intersections need structural support here.
    assert.ok(value.allOf.every((item) => Object.keys(item).every((key) => ['if', 'then', 'else'].includes(key))),
      'Store schema structure differs: structural allOf beside type is unsupported');
  }
  if (value.$ref) return jsonShape(definitions[value.$ref.replace('#/$defs/', '')], definitions);
  if (!value.type && value.allOf) {
    const properties = {};
    for (const item of value.allOf) {
      for (const [name, property] of Object.entries(jsonShape(item, definitions).properties)) {
        if (properties[name]) assert.deepEqual(properties[name].value, property.value, 'Store schema structure differs inside allOf');
        properties[name] = { ...property, required: property.required || properties[name]?.required || false };
      }
    }
    return { properties };
  }
  if (value.oneOf) {
    const shapes = value.oneOf.map((item) => jsonShape(item, definitions));
    const alternatives = shapes.flatMap((item) => item.union ?? [item]);
    assert.equal(new Set(alternatives.map((item) => JSON.stringify(item))).size, alternatives.length,
      'Store schema structure differs: overlapping oneOf branch shapes');
    return union(shapes);
  }
  if (value.type && (value.enum || 'const' in value)) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    const literals = value.enum ?? [value.const];
    assert.ok(literals.every((item) => types.some((type) => type === 'integer' ? Number.isInteger(item)
      : type === 'null' ? item === null : typeof item === type)), 'Store schema structure differs: literal type conflict');
  }
  if (value.enum) return union(value.enum.map(literal));
  if ('const' in value) return literal(value.const);
  if (Array.isArray(value.type)) return union(value.type.map((type) => jsonShape({ ...value, type }, definitions)));
  if (value.type === 'boolean') return union([literal(false), literal(true)]);
  if (value.type === 'array') {
    assert.ok(!value.prefixItems || value.items === false,
      'Store schema structure differs: prefixItems with general items is unsupported');
    return value.prefixItems
      ? { tuple: value.prefixItems.map((item) => jsonShape(item, definitions)) }
      : { array: jsonShape(value.items, definitions) };
  }
  if (value.type === 'object') {
    assert.ok((value.required ?? []).every((name) => Object.hasOwn(value.properties ?? {}, name)),
      'Store schema structure differs: required field has no declaration');
    return {
      properties: Object.fromEntries(Object.entries(value.properties ?? {}).sort(([left], [right]) => left.localeCompare(right))
        .map(([name, property]) => [name, { required: (value.required ?? []).includes(name), value: jsonShape(property, definitions) }])),
      ...(typeof value.additionalProperties === 'object' ? { index: jsonShape(value.additionalProperties, definitions) } : {}),
    };
  }
  if (['string', 'number', 'integer', 'null'].includes(value.type)) return { type: value.type === 'integer' ? 'number' : value.type };
  throw new Error('Unsupported store JSON schema structure');
};

const expected = typeShape(checker.getTypeAtLocation(state));
export const checkStoreSchema = (schema) => {
  // SQL layout and business constraints are checked by migrations and actual store round trips.
  assert.deepEqual(jsonShape(schema, schema.$defs), expected, 'Store schema structure differs from DatabaseState');
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkStoreSchema(JSON.parse(await readFile(resolve(root, 'schema/store-schema.json'), 'utf8')));
  console.log('Store JSON schema matches DatabaseState fields and types');
}
