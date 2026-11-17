import { ErrorCode, JsonRpcError } from "../core/jsonrpc.ts";
import { readResource } from "../resources/index.ts";

// The prompt catalog, independent of any revision. Messages are fixed
// templates filled with the arguments, so the same arguments always give the
// same messages. Only text and embedded resources are used, the content
// types every revision has.

export interface PromptArgument {
  name: string;
  title: string;
  description: string;
  required: boolean;
}

export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgument[];
}

type Message =
  | { role: "user" | "assistant"; content: { type: "text"; text: string } }
  | { role: "user"; content: { type: "resource"; resource: Record<string, unknown> } };

interface Prompt {
  definition: PromptDefinition;
  // Receives validated arguments: every required one present, all strings.
  render(args: Record<string, string>): { description: string; messages: Message[] };
}

const user = (text: string): Message => ({ role: "user", content: { type: "text", text } });

const STYLES = ["brief", "detailed"];
const invalid = (message: string) => new JsonRpcError(ErrorCode.InvalidParams, `Invalid params: ${message}`);

const PROMPTS: readonly Prompt[] = [
  {
    definition: {
      name: "summarize",
      title: "Summarize text",
      description: "Asks for a summary of a text.",
      arguments: [
        { name: "text", title: "Text", description: "The text to summarize.", required: true },
        { name: "style", title: "Style", description: `${STYLES.join(" or ")}. Defaults to brief.`, required: false },
      ],
    },
    render: ({ text, style = "brief" }) => {
      if (!STYLES.includes(style)) throw invalid(`argument "style" must be one of: ${STYLES.join(", ")}`);
      const length = style === "brief" ? "in one or two sentences" : "in a few paragraphs, keeping every key point";
      return {
        description: `A ${style} summary`,
        messages: [user(`Summarize the following text ${length}:\n\n${text}`)],
      };
    },
  },
  {
    definition: {
      name: "code_review",
      title: "Review code",
      description: "Asks for a review of a piece of code.",
      arguments: [
        { name: "code", title: "Code", description: "The code to review.", required: true },
        { name: "language", title: "Language", description: "The programming language, if known.", required: false },
      ],
    },
    render: ({ code, language }) => ({
      description: language ? `A review of ${language} code` : "A code review",
      messages: [
        user(
          `Review this ${language ? `${language} ` : ""}code for bugs, readability and performance. ` +
            `List each issue with its line and a suggested fix.\n\n${code}`,
        ),
      ],
    }),
  },
  {
    definition: {
      name: "weather_report",
      title: "Weather report",
      description: 'Asks for a short weather report, with the city\'s weather embedded as a resource. "Atlantis" is never found.',
      arguments: [{ name: "city", title: "City", description: "The city to report on.", required: true }],
    },
    render: ({ city = "" }) => {
      let contents: Record<string, unknown>;
      try {
        contents = readResource({ uri: `weather://${encodeURIComponent(city)}` }, ErrorCode.InvalidParams).contents[0] as Record<string, unknown>;
      } catch {
        throw invalid(`city not found: ${city}`);
      }
      return {
        description: `A weather report for ${city}`,
        messages: [
          user(`Write a short, friendly weather report for ${city} from this data:`),
          { role: "user", content: { type: "resource", resource: contents } },
        ],
      };
    },
  },
];

export function listPrompts(): PromptDefinition[] {
  return PROMPTS.map((prompt) => prompt.definition);
}

// prompts/get. Unknown prompts, missing required arguments and non-string
// values are protocol errors: prompt arguments are always strings.
export function getPrompt(params: Record<string, unknown> | undefined): { description: string; messages: Message[] } {
  const name = params?.name;
  if (typeof name !== "string") throw invalid('"name" must be a string');
  const prompt = PROMPTS.find((candidate) => candidate.definition.name === name);
  if (!prompt) throw invalid(`unknown prompt: ${name}`);

  const args = params?.arguments ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw invalid('"arguments" must be an object');
  const known = new Set(prompt.definition.arguments.map((argument) => argument.name));
  for (const [key, value] of Object.entries(args)) {
    if (!known.has(key)) throw invalid(`unknown argument "${key}" for prompt ${name}`);
    if (typeof value !== "string") throw invalid(`argument "${key}" must be a string`);
  }
  for (const argument of prompt.definition.arguments) {
    if (argument.required && !(argument.name in args)) throw invalid(`missing required argument "${argument.name}"`);
  }
  return prompt.render(args as Record<string, string>);
}
