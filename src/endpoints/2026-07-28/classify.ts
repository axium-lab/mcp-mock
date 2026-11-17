import {
  ErrorCode,
  type JsonRpcNotification,
  type JsonRpcRequest,
  parseMessage,
} from "../../core/jsonrpc.ts";
import { claimedVersion, hasClaim, META, metaOf, validateEnvelope } from "./envelope.ts";
import { headerMismatch, type Rejection, reject, unsupportedVersion } from "./errors.ts";
import { decodeHeaderValue, nameSource, type StandardHeaders, stripOws } from "./headers.ts";

export type Classified =
  | { kind: "request"; message: JsonRpcRequest; protocolVersion: string }
  | { kind: "notification"; message: JsonRpcNotification }
  | Rejection;

export interface ClassifyOptions {
  supportedVersions: readonly string[];
  // Methods this endpoint serves, to answer unknown ones with 404.
  isKnownMethod: (method: string) => boolean;
}

// The checks a POSTed body goes through before a handler sees it, in the
// precedence the official SDK server answers them with: when a request fails
// several, the earliest one wins.
//
//   1. JSON-RPC shape          400 / -32600 (batches and responses included)
//   2. era                     legacy traffic: 400 / -32022 naming what we serve
//   3. envelope (_meta)        400 / -32602
//   4. header/body agreement   400 / -32020 (version, Mcp-Method)
//   5. supported version       400 / -32022
//   6. standard headers        400 / -32020 (presence, Mcp-Name)
//   7. method registry         404 / -32601
//
// Parameter validation happens later, in the handlers, and is answered
// in-band with HTTP 200.
export function classify(
  body: unknown,
  rawHeaders: StandardHeaders,
  options: ClassifyOptions,
): Classified {
  const headers: StandardHeaders = {
    ...(rawHeaders.protocolVersion !== undefined && {
      protocolVersion: stripOws(rawHeaders.protocolVersion),
    }),
    ...(rawHeaders.method !== undefined && { method: stripOws(rawHeaders.method) }),
    ...(rawHeaders.name !== undefined && { name: stripOws(rawHeaders.name) }),
  };
  const { supportedVersions } = options;

  // 1. Shape. Only 2025-03-26 allowed batches; a client must not POST
  // responses since server-initiated requests became MRTR results.
  if (Array.isArray(body)) {
    return reject(400, undefined, ErrorCode.InvalidRequest, "Invalid Request: JSON-RPC batches are not supported");
  }
  const parsed = parseMessage(body);
  if (parsed.kind === "invalid") return { status: 400, body: parsed.response };
  if (parsed.kind === "response") {
    return reject(400, undefined, ErrorCode.InvalidRequest, "Invalid Request: JSON-RPC responses cannot be posted to this endpoint");
  }

  if (parsed.kind === "notification") return classifyNotification(parsed.message, headers);

  const message = parsed.message;
  const { id, method, params } = message;
  const headerIsSupported =
    headers.protocolVersion !== undefined && supportedVersions.includes(headers.protocolVersion);

  // 2. Era. An initialize without an envelope, or any request without one, is
  // a legacy client: tell it which versions this endpoint serves, since a
  // legacy client has no other way to find out.
  if (!hasClaim(params)) {
    if (method === "initialize" && headerIsSupported) {
      return headerMismatch(
        id,
        `an initialize request (legacy handshake) was sent with MCP-Protocol-Version ${headers.protocolVersion}`,
      );
    }
    if (headerIsSupported) {
      const meta = metaOf(params);
      const missing =
        meta === undefined
          ? ["_meta"]
          : validateEnvelope(meta)
              .filter((issue) => issue.problem === "missing")
              .map((issue) => issue.key);
      return reject(
        400,
        id,
        ErrorCode.InvalidParams,
        `Invalid params: the MCP-Protocol-Version header names ${headers.protocolVersion}, but the request is missing ${missing.join(", ")}`,
        { envelope: { missing } },
      );
    }
    const requested =
      method === "initialize" && typeof params?.protocolVersion === "string"
        ? params.protocolVersion
        : headers.protocolVersion;
    return unsupportedVersion(id, supportedVersions, requested);
  }

  // 3. Envelope.
  const issue = validateEnvelope(metaOf(params) as Record<string, unknown>)[0];
  if (issue) {
    return reject(
      400,
      id,
      ErrorCode.InvalidParams,
      `Invalid params: _meta ${issue.key}: ${issue.problem}`,
      { envelope: issue },
    );
  }
  const version = claimedVersion(params) as string;

  // 4. Header/body agreement.
  if (headers.protocolVersion !== undefined && headers.protocolVersion !== version) {
    return headerMismatch(
      id,
      `MCP-Protocol-Version header value '${headers.protocolVersion}' does not match body value '${version}'`,
    );
  }
  if (headers.method !== undefined && headers.method !== method) {
    return headerMismatch(id, `Mcp-Method header value '${headers.method}' does not match body value '${method}'`);
  }

  // 5. Supported version.
  if (!supportedVersions.includes(version)) {
    return unsupportedVersion(id, supportedVersions, version);
  }

  // 6. Standard headers: presence, and Mcp-Name against the body.
  if (headers.protocolVersion === undefined) {
    return headerMismatch(id, "the required MCP-Protocol-Version header is missing");
  }
  if (headers.method === undefined) {
    return headerMismatch(id, "the required Mcp-Method header is missing");
  }
  const source = nameSource(method, params);
  if (source !== undefined) {
    if (headers.name === undefined) {
      if (source.value !== undefined) {
        return headerMismatch(id, "the required Mcp-Name header is missing");
      }
    } else {
      const decoded = decodeHeaderValue(headers.name);
      if (decoded === undefined) {
        return headerMismatch(id, "the Mcp-Name header carries an invalid Base64 value");
      }
      if (source.value !== undefined && decoded !== source.value) {
        return headerMismatch(
          id,
          `Mcp-Name header value '${decoded}' does not match body value '${source.value}'`,
        );
      }
    }
  }

  // 7. Method registry.
  if (!options.isKnownMethod(method)) {
    return reject(404, id, ErrorCode.MethodNotFound, `Method not found: ${method}`);
  }

  return { kind: "request", message, protocolVersion: version };
}

// No client-to-server notification exists over Streamable HTTP in this
// revision, so every acceptable notification is acknowledged with 202 and
// dropped. Only a notification that claims the modern era and gets its
// envelope or headers wrong is refused.
function classifyNotification(message: JsonRpcNotification, headers: StandardHeaders): Classified {
  const { method, params } = message;
  if (!hasClaim(params)) return { kind: "notification", message };

  const version = claimedVersion(params);
  if (version === undefined) {
    return reject(
      400,
      undefined,
      ErrorCode.InvalidParams,
      `Invalid params: _meta ${META.protocolVersion}: expected a protocol version string`,
    );
  }
  if (headers.protocolVersion !== undefined && headers.protocolVersion !== version) {
    return headerMismatch(
      undefined,
      `MCP-Protocol-Version header value '${headers.protocolVersion}' does not match body value '${version}'`,
    );
  }
  if (headers.method !== undefined && headers.method !== method) {
    return headerMismatch(
      undefined,
      `Mcp-Method header value '${headers.method}' does not match body value '${method}'`,
    );
  }
  return { kind: "notification", message };
}
