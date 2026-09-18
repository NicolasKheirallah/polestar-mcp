import type { McpServer } from '@modelcontextprotocol/server';
import type { ZodTypeAny } from 'zod';
import { resultShape, type ToolContext, type ToolResult } from './tool-output.js';

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
  annotations: { readOnlyHint: true; openWorldHint?: boolean };
  /**
   * Method syntax, deliberately: it keeps the parameter bivariant, so one
   * `ToolSpec[]` can hold a tool that takes `{ vin?: string }` beside one that
   * takes `{ prices: PriceSlot[] }` while each body still sees its own type.
   */
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * The only place in the tree that touches the SDK's registration surface. Every
 * tool declares the same output envelope, so that fact lives here instead of in
 * twenty-six object literals.
 */
export function registerTools(server: McpServer, specs: ToolSpec[]): void {
  for (const spec of specs) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        ...(spec.args === undefined ? {} : { inputSchema: spec.args }),
        outputSchema: resultShape,
        annotations: spec.annotations,
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
