import type { SkillEnv, ToolDef } from "./types.ts";
import { executeSkill } from "./skills.ts";

const text = { type: "string", minLength: 1 };
const coordinate = { type: "number" };
const blockCoordinate = { type: "integer" };
const count = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const xyz = { x: blockCoordinate, y: blockCoordinate, z: blockCoordinate };
const itemCount = { item: text, count };
const face = { type: "string", enum: ["up", "down", "north", "south", "east", "west"] };

function define(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolDef {
  const parameters = { type: "object", properties, required, additionalProperties: false };
  return {
    name, description, parameters,
    async run(args, env: SkillEnv) {
      const error = validateArguments(parameters, args);
      if (error) return { ok: false, summary: error, observedDelta: {} };
      return executeSkill(name, args, env);
    },
  };
}

// Keep argument validation at dispatch as well as in the model-facing schema.
export function validateArguments(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const required = schema.required as string[];
  for (const key of required) if (!(key in args)) return `missing argument: ${key}`;
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (!property) return `unknown argument: ${key}`;
    if (property.type === "string" && (typeof value !== "string" || !value.trim())) return `invalid argument: ${key}`;
    if (property.type === "boolean" && typeof value !== "boolean") return `invalid argument: ${key}`;
    if (property.type === "number" || property.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value) || (property.type === "integer" && !Number.isSafeInteger(value))) return `invalid argument: ${key}`;
      if (typeof property.minimum === "number" && value < property.minimum) return `invalid argument: ${key}`;
      if (typeof property.maximum === "number" && value > property.maximum) return `invalid argument: ${key}`;
    }
    if (Array.isArray(property.enum) && !property.enum.includes(value)) return `invalid argument: ${key}`;
  }
  return null;
}

export const TOOLS: ToolDef[] = [
  define("observe", "Read a fresh compact observation; unavailable fields remain explicit."),
  define("look_screenshot", "Capture one PNG image of the visible client."),
  define("go_to", "Travel to coordinates within the home radius. Without y, range is ignored.", { x: coordinate, y: coordinate, z: coordinate, range: { type: "number", minimum: 0 } }, ["x", "z"]),
  define("go_to_player", "Approach a uniquely visible named player, then stop within three blocks.", { name: text }, ["name"]),
  define("follow_player", "Track a uniquely visible named player for a bounded thirty-second interval.", { name: text }, ["name"]),
  define("explore", "Explore around x/z for thirty seconds and report observed progress.", { x: coordinate, z: coordinate }, ["x", "z"]),
  define("collect", "Acquire count NEW units of a supported block-produced item; not a final inventory count.", itemCount, ["item", "count"]),
  define("mine", "Mine a supported natural block for count NEW units of its drop.", { block: text, count }, ["block", "count"]),
  define("craft", "Produce count NEW units using unlocked recipes and authorized/own crafting stations.", itemCount, ["item", "count"]),
  define("smelt", "Produce count NEW units using a known recipe and an authorized/own furnace.", { ...itemCount, fuel: text }, ["item", "count"]),
  define("place_block", "Place held block item at exactly the requested target; face selects its support face.", { item: text, ...xyz, face }, ["item", "x", "y", "z"]),
  define("break_block", "Break one loaded natural unprotected block in survival mode.", xyz, ["x", "y", "z"]),
  define("equip", "Equip an item in a hand or armor slot.", { item: text, slot: { type: "string", enum: ["mainHand", "offHand", "helmet", "chest", "legs", "boots"] } }, ["item"]),
  define("eat", "Consume an observed edible item and verify food or inventory change.", { item: text }),
  define("attack", "Attack a unique UUID/type or visually named entity; only observed damage counts as success.", { target: text }, ["target"]),
  define("chest_deposit", "Move exactly count items into the explicitly targeted chest and verify both inventories.", { ...xyz, ...itemCount }, ["x", "y", "z", "item", "count"]),
  define("chest_withdraw", "Take exactly count items from the explicitly targeted chest and verify both inventories.", { ...xyz, ...itemCount }, ["x", "y", "z", "item", "count"]),
  define("drop", "Drop exactly count inventory items and verify the decrease.", itemCount, ["item", "count"]),
  define("chat_say", "Submit public conversational text through the chat budget; no slash commands.", { text }, ["text"]),
  define("chat_reply", "Reply to a known recipient through chat policy, using its observed whisper identity.", { to: text, text }, ["to", "text"]),
  define("run_command", "Submit an allowlisted player slash command; travel must have an observed consequence.", { command: text }, ["command"]),
  define("remember", "Persist a server/dimension-scoped named note, optionally at coordinates.", { kind: text, name: text, note: text, x: coordinate, y: coordinate, z: coordinate }, ["kind", "name", "note"]),
  define("recall", "Return matching notes with their context and age, or an explicit empty result.", { query: text }, ["query"]),
  define("set_goal", "Update the controller goal, not claim it achieved.", { text }, ["text"]),
  define("finish_goal", "Close a goal with a free-form summary after a successful recorded tool result, or start the summary with 'abandoned:' to abandon it.", { summary: text }, ["summary"]),
  define("wait", "Wait an interruptible finite duration while events and lease continue.", { seconds: { type: "number", minimum: 0, maximum: 3600 } }, ["seconds"]),
  define("stop", "Stop all synthetic body actions and verify the task is inactive; does not pause the operator session."),
  define("harness_info", "Search redacted harness docs and code for honest answers about this agent.", { question: text }, ["question"]),
];

export function toolsForLlm(tools: ToolDef[]): Record<string, unknown>[] {
  return tools.map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } }));
}
