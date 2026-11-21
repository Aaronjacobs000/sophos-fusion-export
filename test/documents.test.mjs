// Every GraphQL document the exporter sends is a query that validates
// against the documented Sophos Fusion schema it belongs to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSchema, parse, validate, OperationTypeNode } from "graphql";
import { DOCUMENTS } from "../dist/sophos/documents.js";

const schemaFor = {
  ExportCasesPage: "cases-v2",
  ExportCaseReferenceData: "cases-v2",
  ExportDetectionSearch: "detections-v2",
  ExportDetectionCount: "detections-v2",
};

const schemas = new Map();
function schema(name) {
  if (!schemas.has(name)) {
    const sdl = readFileSync(new URL(`../schemas/fusion/${name}.graphql`, import.meta.url), "utf8");
    schemas.set(name, buildSchema(sdl, { assumeValidSDL: true }));
  }
  return schemas.get(name);
}

test("every document has a schema to check against", () => {
  assert.deepEqual([...DOCUMENTS.keys()].sort(), Object.keys(schemaFor).sort());
});

for (const [name, document] of DOCUMENTS) {
  test(`${name} is one named query that validates against ${schemaFor[name]}`, () => {
    const ast = parse(document);
    assert.equal(ast.definitions.length, 1);
    const [op] = ast.definitions;
    assert.equal(op.kind, "OperationDefinition");
    assert.equal(op.operation, OperationTypeNode.QUERY);
    assert.equal(op.name?.value, name);
    const errors = validate(schema(schemaFor[name]), ast);
    assert.deepEqual(errors.map((e) => e.message), []);
  });
}
