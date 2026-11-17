import { normalizeText, seeded } from "../hash.ts";
import { structured, type Tool, type ToolAnnotations, toolError } from "../types.ts";
import { FIRST_NAMES, LAST_NAMES, LOOKUP, RESERVED, ROLES } from "./data.ts";

export const getUser: Tool = {
  definition: {
    name: "get_user",
    title: "Get user",
    description: `Gets a user profile by ID. Fake but stable: the same ID is always the same person. "${RESERVED.userId}" is never found.`,
    inputSchema: {
      type: "object",
      properties: { user_id: { type: "string", minLength: 1, description: "The user ID." } },
      required: ["user_id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        role: { type: "string", enum: [...ROLES] },
        created_at: { type: "string", description: "ISO 8601 date." },
      },
      required: ["id", "name", "email", "role", "created_at"],
    },
    annotations: LOOKUP,
  },
  run: ({ user_id }) => {
    // IDs are case-sensitive: only surrounding whitespace is dropped.
    const id = (user_id as string).trim();
    if (id === RESERVED.userId) return toolError(`User not found: ${id}`);

    const random = seeded("get_user", id);
    const first = random.pick(FIRST_NAMES);
    const last = random.pick(LAST_NAMES);
    const year = random.int(2015, 2025);
    const month = String(random.int(1, 12)).padStart(2, "0");
    const day = String(random.int(1, 28)).padStart(2, "0");
    return structured({
      id,
      name: `${first} ${last}`,
      email: `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, "") + "@example.com",
      role: random.pick(ROLES),
      created_at: `${year}-${month}-${day}`,
    });
  },
};

// A write with nothing written: the "sent" message is never stored, and its
// ID comes from the hash of the message, so the tool stays stateless.
const SEND: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const sendEmail: Tool = {
  definition: {
    name: "send_email",
    title: "Send email",
    description: `Sends an email. Nothing is really sent: it returns a stable message ID. Mail to "${RESERVED.bouncingEmail}" bounces.`,
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", pattern: "^\\s*[^@\\s]+@[^@\\s]+\\.[^@\\s]+\\s*$", description: "The recipient address." },
        subject: { type: "string", description: "The subject line." },
        body: { type: "string", description: "The message body." },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string" },
        to: { type: "string" },
        status: { type: "string", enum: ["sent"] },
      },
      required: ["message_id", "to", "status"],
    },
    annotations: SEND,
  },
  run: ({ to, subject, body }) => {
    const recipient = normalizeText(to as string);
    if (recipient === RESERVED.bouncingEmail) {
      return toolError(`Delivery failed: the mailbox ${recipient} does not exist`);
    }
    const random = seeded("send_email", { to: recipient, subject, body });
    return structured({ message_id: `msg_${random.hex(12)}`, to: recipient, status: "sent" });
  },
};
