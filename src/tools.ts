import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { resultSchema, type ToolContext, type ToolResult } from './tool-output.js';

/**
 * One tool, described rather than registered as a side effect.
 *
 * The layer used to expose itself as `registerXTools(server, deps)`: five
 * modules mutating a concrete `McpServer` and returning nothing, which left every
 * handler body addressable only from a live protocol client. A spec is a value,
 * so the caller's interface and the test's interface are now the same seam:
 * `spec.run(args, ctx)` is exactly what the SDK invokes.
 *
 * Wiring (`deps`) is bound when a family builds its specs, which keeps `run`'s
 * signature, arguments the SDK validated, plus the call context, the one thing
 * a caller, a test and the registrar all agree on.
 */
export interface ToolSpec<A extends object = Record<string, unknown>> {
  name: string;
  title: string;
  description: string;
  /** Argument shape; the SDK validates and parses against it before `run` is called. */
  args?: Record<string, ZodTypeAny>;
  /**
   * Every tool this server exposes is a read, so `readOnlyHint` is the literal
   * `true` and cannot be forgotten.
   *
   * `openWorldHint` says whether a call can reach outside this process. It is
   * optional here and defaults to false at registration, which is what the
   * system and history tools mean: they read local state. A tool that talks to
   * the Polestar API states `openWorldHint: true`; the default is the honest
   * answer for the local case, not a permission to omit it from a network tool.
   *
   * `idempotentHint` defaults to true for the same reason `readOnlyHint` is
   * literal: repeating a read cannot change an outcome. A tool that becomes
   * stateful stops being read-only first, so the default cannot lie silently.
   */
  annotations: {
    readOnlyHint: true;
    openWorldHint?: boolean;
    idempotentHint?: boolean;
  };
  /**
   * Method syntax, deliberately: it keeps the parameter bivariant, so one
   * `ToolSpec[]` can hold a tool that takes `{ vin?: string }` beside one that
   * takes `{ prices: PriceSlot[] }` while each body still sees its own type.
   */
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * The one place that registers a tool. Resources, prompts and the two
 * subscription handlers are registered next to the code that owns them, in
 * server.ts; what lives here is the part every tool must declare identically,
 * so the output envelope is written once instead of in twenty-six literals.
 * The smoke run asserts an outputSchema on every registered name, which is what
 * makes a tool registered around this function visible rather than silent.
 *
 * Arguments are wrapped in a strict object rather than handed over as a raw
 * shape. The SDK strips unknown keys when it parses a raw shape, so
 * `get_battery {"vinn": ...}` used to answer normally about the default car:
 * a misspelled VIN is exactly the mistake a caller cannot see. A strict object
 * turns it into `Unrecognized key: "vinn"`, refused by name before the handler
 * runs, and the JSON Schema advertised in `tools/list` says
 * `additionalProperties: false`.
 */
export function registerTools(server: McpServer, specs: ToolSpec[]): void {
  for (const spec of specs) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: z.object(spec.args ?? {}).strict(),
        outputSchema: resultSchema,
        annotations: {
          readOnlyHint: spec.annotations.readOnlyHint,
          // Explicit in every registration: the protocol's default is true, and a
          // local tool inheriting that is how a client learns to auto-approve a
          // call that only read this process's own state.
          openWorldHint: spec.annotations.openWorldHint ?? false,
          idempotentHint: spec.annotations.idempotentHint ?? true,
        },
      },
      (args: unknown, ctx: unknown) => spec.run((args ?? {}) as Record<string, unknown>, (ctx ?? {}) as ToolContext),
    );
  }
}

/** Names, for the instruction text and the smoke expectation. */
export function toolNames(specs: ToolSpec[]): string[] {
  return specs.map((s) => s.name);
}

/** Look a spec up by name; throws rather than returning undefined so a typo is loud. */
export function toolSpec(specs: ToolSpec[], name: string): ToolSpec {
  const found = specs.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no tool spec named ${JSON.stringify(name)}`);
  return found;
}
