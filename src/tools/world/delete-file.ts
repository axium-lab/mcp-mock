import { createHash } from "node:crypto";
import { ErrorCode, JsonRpcError } from "../../core/jsonrpc.ts";
import {
  type CallContext,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  structured,
  type Tool,
  type ToolAnnotations,
  toolError,
} from "../types.ts";
import { RESERVED } from "./data.ts";

const DELETE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const CONFIRM = "confirm_delete";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The requestState binds a confirmation to the file it was asked for, so a
// confirmation cannot be replayed on another path. No secret is involved:
// the spec lets integrity protection go when tampering can cause nothing
// worse than the request failing, and here a forged state only fails.
function stateFor(path: string): string {
  const digest = createHash("sha256").update(`delete_file\n${path}`).digest("hex").slice(0, 32);
  return Buffer.from(JSON.stringify({ tool: "delete_file", digest })).toString("base64url");
}

// Form-mode elicitation: an empty elicitation capability means form, and an
// explicit one must list it.
function canAskForm(capabilities: Record<string, unknown>): boolean {
  const elicitation = capabilities.elicitation;
  if (!isObject(elicitation)) return false;
  return Object.keys(elicitation).length === 0 || "form" in elicitation;
}

function confirm(path: string, mrtr: NonNullable<CallContext["mrtr"]>) {
  if (!canAskForm(mrtr.clientCapabilities)) {
    throw new JsonRpcError(
      MISSING_REQUIRED_CLIENT_CAPABILITY,
      "Missing required client capability: delete_file asks for confirmation through form elicitation",
      { requiredCapabilities: { elicitation: { form: {} } } },
    );
  }

  const answer = mrtr.inputResponses?.[CONFIRM];
  if (answer === undefined) {
    return {
      resultType: "input_required" as const,
      inputRequests: {
        [CONFIRM]: {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: `Delete ${path}? This cannot be undone.`,
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean", title: "Delete the file", default: false } },
              required: ["confirm"],
            },
          },
        },
      },
      requestState: stateFor(path),
    };
  }

  if (mrtr.requestState !== stateFor(path)) {
    throw new JsonRpcError(
      ErrorCode.InvalidParams,
      "Invalid params: requestState does not match this request; echo the value the server sent",
    );
  }
  if (!isObject(answer) || !["accept", "decline", "cancel"].includes(answer.action as string)) {
    throw new JsonRpcError(
      ErrorCode.InvalidParams,
      `Invalid params: inputResponses.${CONFIRM} must be an elicitation result with an action`,
    );
  }
  const confirmed = answer.action === "accept" && isObject(answer.content) && answer.content.confirm === true;
  return confirmed ? undefined : toolError(`Deletion cancelled: ${path} was not deleted`);
}

// A destructive tool that confirms before acting. On 2026-07-28 it asks
// through a multi round-trip request; on legacy revisions, which cannot ask,
// it proceeds, leaving confirmation to the client as 2025 did through the
// destructiveHint annotation. Nothing is really deleted, so the tool stays
// stateless: the same file can be deleted again and again.
export const deleteFile: Tool = {
  definition: {
    name: "delete_file",
    title: "Delete file",
    description: `Deletes a file from the fake file system after asking the user to confirm (on protocol revisions that can ask). Nothing is really deleted. Paths with ".." are refused, and "${RESERVED.filePath}" does not exist.`,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1, description: "Absolute path of the file." } },
      required: ["path"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { path: { type: "string" }, deleted: { type: "boolean" } },
      required: ["path", "deleted"],
    },
    annotations: DELETE,
  },
  run: ({ path }, context) => {
    const value = (path as string).trim();
    if (value.split("/").includes("..")) return toolError(`Access denied: "${value}" leaves the root directory`);
    const absolute = value.startsWith("/") ? value : `/${value}`;
    if (absolute === RESERVED.filePath) return toolError(`File not found: ${absolute}`);

    if (context.mrtr) {
      const pending = confirm(absolute, context.mrtr);
      if (pending) return pending;
    }
    return structured({ path: absolute, deleted: true });
  },
};
