import { structured, type Tool, toolError } from "../types.ts";

// Waits `ms`, or less if the request is cancelled meanwhile.
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// A slow tool, for progress and cancellation. It really waits between steps,
// reports each one when the request carries a progress token, and stops as
// soon as the request is cancelled. Its result depends only on its arguments;
// only the time it takes varies.
export const simulateWork: Tool = {
  definition: {
    name: "simulate_work",
    title: "Simulate work",
    description:
      "Works through a number of steps, waiting between them, and reports progress on each when the request asks for it. Use it to test progress notifications, timeouts and cancellation.",
    inputSchema: {
      type: "object",
      properties: {
        steps: { type: "integer", minimum: 1, maximum: 20, description: "How many steps. Defaults to 5." },
        step_ms: {
          type: "integer",
          minimum: 0,
          maximum: 2000,
          description: "Milliseconds each step takes. Defaults to 100.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { steps: { type: "integer" }, completed: { type: "boolean" } },
      required: ["steps", "completed"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  run: async ({ steps, step_ms }, { report, signal }) => {
    const total = (steps as number | undefined) ?? 5;
    const ms = (step_ms as number | undefined) ?? 100;
    for (let step = 1; step <= total; step++) {
      await sleep(ms, signal);
      // Nobody receives this: a cancelled request gets no response.
      if (signal?.aborted) return toolError("Cancelled");
      report?.({ progress: step, total, message: `Step ${step} of ${total}` });
    }
    return structured({ steps: total, completed: true });
  },
};
