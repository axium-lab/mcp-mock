import { randomUUID } from "node:crypto";
import express, { type Request, type Response, Router } from "express";
import { CONTROL, forcedStatus } from "../../core/control.ts";
import { dispatch, parseJson, parseMessage } from "../../core/jsonrpc.ts";
import { PROFILE_2025_03_26 } from "../2025-03-26/index.ts";
import { answerBatch, handlersFor, profileFor } from "../2025-11-25/index.ts";
import type { LegacyProfile } from "../2025-11-25/profile.ts";
import type { Endpoint } from "../types.ts";

// 2024-11-05 is 2025-03-26 without batching, without tool annotations, which
// arrived in 2025-03-26 (and with them the only place a display title could
// go, so the title is dropped), and without audio content. The catalog never
// returns audio, but a result forced from the test can.
export const PROFILE_2024_11_05: LegacyProfile = {
  ...PROFILE_2025_03_26,
  revision: "2024-11-05",
  batching: false,
  adaptDefinition: ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
  adaptResult: ({ content, isError }) => ({
    content: content.filter((block) => block.type !== "resource_link" && (block.type as string) !== "audio"),
    ...(isError !== undefined && { isError }),
  }),
};

// The HTTP failure a test forces with x-mcp-mock-status, answered in plain
// text like the transport's other refusals. Returns whether it answered.
function sendForcedStatus(req: Request, res: Response): boolean {
  const forced = forcedStatus(req.get(CONTROL.statusHeader));
  if (!forced) return false;
  res.status(forced.status).set(forced.headers).type("text/plain").send(forced.message);
  return true;
}

// The HTTP+SSE transport of 2024-11-05, the one part of the mock that keeps
// state. A client opens GET <base>/sse; the first event names the URL it must
// POST its messages to, and every answer travels back on that open stream,
// not in the POST's response. Pairing the two needs the open stream kept by
// session id, for as long as the connection lasts and no longer: nothing is
// persisted, and a dropped connection forgets its session.
//
// Where the spec leaves details open, this follows the official SDK's
// SSEServerTransport: plain-text "Accepted" and error bodies, a relative
// endpoint URL, `message` events carrying one JSON-RPC message each.

interface SseSession {
  stream: Response;
  // Set by initialize. Sessions are the one place a negotiated version can be
  // remembered, so it is: until then, the transport's own revision applies.
  profile?: LegacyProfile;
}

function event(stream: Response, name: string, data: string): void {
  stream.write(`event: ${name}\ndata: ${data}\n\n`);
}

// `profiles` (newest first) are the revisions initialize may negotiate. The
// pinned endpoint offers only 2024-11-05; the root /sse of the dual-era
// endpoint offers every legacy revision, since protocol version and transport
// are independent and clients do speak newer revisions over this transport.
export function sseRouter(profiles: readonly LegacyProfile[]): Router {
  const sessions = new Map<string, SseSession>();
  const native = profiles.find((profile) => profile.revision === "2024-11-05") ?? (profiles[0] as LegacyProfile);
  const router = Router();

  router.get("/sse", (req, res) => {
    if (sendForcedStatus(req, res)) return;
    const sessionId = randomUUID();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    sessions.set(sessionId, { stream: res });
    req.on("close", () => sessions.delete(sessionId));
    event(res, "endpoint", `${req.baseUrl}/messages?sessionId=${sessionId}`);
  });

  router.post("/messages", express.text({ type: () => true, limit: "4mb" }), (req, res, next) => {
    (async () => {
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
      const session = sessionId === undefined ? undefined : sessions.get(sessionId);
      if (!session) {
        res.status(404).type("text/plain").send("Session not found");
        return;
      }
      const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        res.status(400).type("text/plain").send(`Unsupported content-type: ${contentType || "none"}`);
        return;
      }
      if (sendForcedStatus(req, res)) return;

      const json = parseJson(typeof req.body === "string" ? req.body : "");
      const profile = session.profile ?? native;
      if (json.ok && Array.isArray(json.value) && profile.batching) {
        const outcome = await answerBatch(json.value, profile);
        if (outcome.kind === "refused") {
          res.status(400).type("text/plain").send(`Invalid message: ${outcome.rejection.body.error.message}`);
          return;
        }
        if (outcome.kind === "answers") event(session.stream, "message", JSON.stringify(outcome.answers));
        res.status(202).type("text/plain").send("Accepted");
        return;
      }

      const parsed = json.ok && !Array.isArray(json.value) ? parseMessage(json.value) : undefined;
      if (!parsed || parsed.kind === "invalid") {
        res.status(400).type("text/plain").send(`Invalid message: ${req.body as string}`);
        return;
      }

      if (parsed.kind === "request") {
        if (parsed.message.method === "initialize") {
          session.profile = profileFor(parsed.message, undefined, profiles);
        }
        const served = session.profile ?? native;
        const response = await dispatch(parsed.message, handlersFor(served), {});
        event(session.stream, "message", JSON.stringify(response));
      }
      // Notifications and responses are accepted and need no answer.
      res.status(202).type("text/plain").send("Accepted");
    })().catch(next);
  });

  return router;
}

export const endpoint20241105: Endpoint = {
  name: PROFILE_2024_11_05.revision,
  mountPath: `/${PROFILE_2024_11_05.revision}`,
  entryPaths: ["/sse"],
  revisions: ["2024-11-05"],
  createRouter: () => sseRouter([PROFILE_2024_11_05]),
};
