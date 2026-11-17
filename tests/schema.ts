import { readFileSync } from "node:fs";
import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { REVISIONS, type RevisionId } from "../src/core/revisions.ts";

// ajv-formats ships CommonJS with a default export, which Node ESM type
// resolution sees as the module object.
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;

// Validates messages against the official schema.json of a revision, vendored
// in schemas/ by `bun run schemas:fetch`. This is the faithfulness check: the
// SDK clients prove the mock is usable, the schemas prove it is correct, and
// they catch fields that leak from one revision into another.
//
// Up to 2025-06-18 the schemas are draft-07 with `definitions`; from
// 2025-11-25 they are draft 2020-12 with `$defs`, which needs Ajv2020.

const validators = new Map<RevisionId, (definition: string) => ValidateFunction>();

for (const { id } of REVISIONS) {
  const schema = JSON.parse(readFileSync(`schemas/${id}/schema.json`, "utf-8")) as Record<
    string,
    unknown
  >;
  const modern = typeof schema.$schema === "string" && schema.$schema.includes("2020-12");
  const ajv = modern ? new Ajv2020({ strict: false }) : new Ajv({ strict: false });
  addFormats(ajv);
  ajv.addSchema(schema as AnySchema, id);
  const pointer = modern ? "$defs" : "definitions";

  const cache = new Map<string, ValidateFunction>();
  validators.set(id, (definition) => {
    let validate = cache.get(definition);
    if (!validate) {
      validate = ajv.getSchema(`${id}#/${pointer}/${definition}`);
      if (!validate) throw new Error(`${id}: the schema has no definition named ${definition}`);
      cache.set(definition, validate);
    }
    return validate;
  });
}

export interface SchemaResult {
  valid: boolean;
  // Ajv's messages, prefixed with the failing path, for readable assertions.
  errors: string[];
}

export function validateAgainst(
  revision: RevisionId,
  definition: string,
  value: unknown,
): SchemaResult {
  const validate = (validators.get(revision) as (definition: string) => ValidateFunction)(
    definition,
  );
  const valid = validate(value);
  return {
    valid,
    errors: (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`),
  };
}

// Revisions whose schema requires an id on every error response, leaving an
// error with no readable request id no valid form at all.
const ID_REQUIRED: readonly RevisionId[] = ["2025-06-18", "2025-03-26", "2024-11-05"];

// The one most tests want: is this a valid message on the wire for the
// revision?
//
// One deliberate exception: in the revisions above, the mock answers such an
// error with `id: null`, as JSON-RPC 2.0 and the official SDK server do. The
// schema cannot express it, so the rest of the message is checked as if the
// id were a real one.
export function validateMessage(revision: RevisionId, value: unknown): SchemaResult {
  if (!ID_REQUIRED.includes(revision)) return validateAgainst(revision, "JSONRPCMessage", value);
  const substitute = (message: unknown) => {
    const body = message as { id?: unknown; error?: unknown } | null;
    return body?.id === null && body.error !== undefined ? { ...body, id: 0 } : message;
  };
  // A 2025-03-26 batch response can carry such errors among its elements.
  const checked = Array.isArray(value) ? value.map(substitute) : substitute(value);
  return validateAgainst(revision, "JSONRPCMessage", checked);
}
