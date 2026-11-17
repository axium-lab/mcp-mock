// A raw client for the 2024-11-05 HTTP+SSE transport: opens the stream, reads
// the endpoint event, posts messages and hands back each `message` event, so
// tests can check the exact bytes the SDK would only see parsed.

export interface SseEvent {
  event: string;
  data: string;
}

export interface SseConnection {
  // Absolute URL to POST messages to, from the endpoint event.
  endpoint: string;
  // The raw data of the endpoint event, as the server wrote it.
  endpointData: string;
  status: number;
  headers: Headers;
  next(): Promise<SseEvent>;
  post(body: unknown, init?: { contentType?: string; raw?: string }): Promise<Response>;
  // Posts a message and returns the JSON of the next `message` event.
  call(body: unknown): Promise<any>;
  close(): void;
}

export async function openSse(url: string): Promise<SseConnection> {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal: controller.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const next = async (): Promise<SseEvent> => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const fields = Object.fromEntries(
          block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
        );
        return { event: fields.event ?? "message", data: fields.data ?? "" };
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream closed");
      buffer += decoder.decode(value, { stream: true });
    }
  };

  const first = await next();
  if (first.event !== "endpoint") throw new Error(`expected an endpoint event, got ${first.event}`);
  const endpoint = new URL(first.data, url).toString();

  const post = (body: unknown, init: { contentType?: string; raw?: string } = {}) =>
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": init.contentType ?? "application/json" },
      body: init.raw ?? JSON.stringify(body),
    });

  return {
    endpoint,
    endpointData: first.data,
    status: res.status,
    headers: res.headers,
    next,
    post,
    async call(body) {
      const accepted = await post(body);
      if (accepted.status !== 202) throw new Error(`POST answered ${accepted.status}: ${await accepted.text()}`);
      const message = await next();
      return JSON.parse(message.data);
    },
    close: () => controller.abort(),
  };
}
