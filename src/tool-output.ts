import { z } from 'zod';
import type { PolestarClient } from './client.js';
import type { Units } from './format.js';
import { maskVinsInText } from './format.js';
import { describeFailure, toFailure, type MintedCode } from './failure.js';

export const vinArg = {
  vin: z
    .string()
    .optional()
    .describe(
      'Vehicle Identification Number; omit it when the credential sees exactly one vehicle.',
    ),
};

/**
 * The arguments a tool that reads one Vehicle accepts.
 *
 * A tool that reads a car takes a VIN and a delegation, or it is a tool that only
 * looks like one. `delegated_account_id` used to be declared by the 15 Domain tools
 * alone, so a fleet operator could delegate `get_battery` but not `get_car_status`,
 * and the argument was silently dropped by the SDK rather than refused.
 */
export interface VinArgs {
  vin?: string;
  delegated_account_id?: string;
}

/** A domain read: the Vehicle, and whether to include the raw payload. */
export interface ReadArgs extends VinArgs {
  raw?: boolean;
}

export const rawArg = {
  raw: z
    .boolean()
    .optional()
    .describe(
      'Return the raw API payload too. It carries the VIN even when POLESTAR_REDACT_VIN is on.',
    ),
};

/** Per-call account selector for third-party credentials; allowlist-checked. */
export const delegatedAccountArg = {
  delegated_account_id: z
    .string()
    .optional()
    .describe('Third-party credentials only: read this account for this call. Must be listed in POLESTAR_DELEGATED_ACCOUNT_IDS.'),
};

export interface ToolDeps {
  client: PolestarClient;
  redactVin: boolean;
  /** Owner-supplied VIN → name; the API itself never returns one. */
  vehicleLabels: Record<string, string>;
  /** Accounts a caller may switch to per call; empty means the argument is refused. */
  delegatedAccounts: string[];
  /** The operator's distance unit, carried to every rendering site rather than set globally. */
  units: Units;
  /**
   * POLESTAR_ALLOW_LOCATION. Optional on the type so a unit test can build deps
   * without it; false is the only value that disables position reads, matching
   * the client's own check.
   */
  allowLocation?: boolean;
  nowMs?: () => number;
}

/**
 * The one output envelope every tool declares.
 *
 * With `outputSchema` set the SDK validates each result against it, so "this tool
 * returns text a model has to parse" becomes a checked contract: clients branch on
 * `ok` and read `data` structurally, and a result that drifts from the schema
 * fails loudly instead of quietly changing shape under every consumer.
 *
 * The shape is shared by every tool and repeated in `tools/list` once per tool,
 * so it stays compact on purpose. Field descriptions are absent: this schema
 * measured 1,009 bytes with them and 401 without, repeated once per tool. The
 * contract is this schema plus the comment on each field below.
 *
 * `message` is sent only when it is not the content text. A success already
 * carries its text in the content block, so repeating it there doubled every
 * payload; a failure keeps a `message` because its content block appends the one
 * hint, and machine clients want the refusal without the advice attached.
 *
 * `data` is the payload contract. A tool whose result carries a machine-readable
 * payload attaches it with `withData()` and owns that payload's shape; a tool
 * with nothing structured to say omits the field rather than sending an empty
 * one. The shape is not frozen into JSON Schema here: a per-tool schema would be
 * repeated in `tools/list` for every tool and undo the saving this shared shape
 * exists for, so the tool owns the shape and its tests hold it.
 */
export const resultShape = {
  /** False when the call produced no data. */
  ok: z.boolean(),
  /** The refusal text when it differs from the content block; omitted on success. */
  message: z.string().optional(),
  /** Tool that produced this result. */
  tool: z.string().optional(),
  /** Vehicle the result is about, masked when POLESTAR_REDACT_VIN is on. */
  vin: z.string().optional(),
  /** Documented payload; shape belongs to the tool. Omitted when there is none. */
  data: z.unknown().optional(),
  /** Staleness of the underlying telemetry. */
  ageSeconds: z.number().nonnegative().optional(),
  /** Machine-readable error code when ok is false. */
  code: z.string().optional(),
  /** Upstream HTTP status when ok is false. */
  httpStatus: z.number().optional(),
  /** Upstream request id, the handle support needs, only when upstream sent one. */
  requestId: z.string().optional(),
  /** Actionable guidance when ok is false, sent once as a field. */
  hint: z.string().optional(),
};

/**
 * `resultShape` as the SDK takes it. Every tool registers this one value, which
 * is what makes the envelope identical across the surface instead of copied
 * twenty-six times with a chance to drift.
 */
export const resultSchema = z.object(resultShape);

/** A payload a tool documents for its `data` field. */
export type ToolData = Record<string, unknown>;

/** Standard text content wrapper, carrying the matching structured envelope. */
export function text(
  content: string,
  extra?: Partial<{ vin: string; data: unknown; ageSeconds: number; tool: string }>,
): ToolResult {
  return {
    content: [{ type: 'text', text: content }],
    structuredContent: { ok: true, ...extra },
  };
}

/**
 * Attach a documented payload to a successful result.
 *
 * `text(content, { data })` can attach a payload too, but a tool that promises
 * one in its description should say so at the call site, and a reader should not
 * have to check whether the field was spelled right. This is that helper; the
 * shape is the tool's own and is documented next to the tool.
 */
export function withData(
  content: string,
  data: ToolData,
  extra?: Partial<{ vin: string; ageSeconds: number; tool: string }>,
): ToolResult {
  return text(content, { ...extra, data });
}

// A type alias, not an interface: the SDK's callback result carries an index
// signature, and TypeScript only infers one for object type aliases.
export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

/**
 * Advice for every code this server mints, keyed by the closed union so adding a
 * code without deciding what to tell the caller is a type error. The Data
 * Portal's own codes are open-ended and handled separately below.
 */
const MINTED_HINTS: Record<MintedCode, string> = {
  INVALID_VIN: 'A VIN is 17 characters from the alphabet without I, O or Q. Call list_vehicles for the identifiers this credential may read.',
  AMBIGUOUS_VIN: 'This credential can see more than one vehicle and none was named. Pass a vin, or call list_vehicles first.',
  VIN_NOT_CHOSEN: 'No vehicle was chosen when the client was asked. Name a vin from list_vehicles and call again.',
  NO_VEHICLES: 'The credential authorizes no vehicle at all; check the Data Portal sharing setup rather than retrying.',
  VIN_MISMATCH: 'The response was labelled a different vehicle than the one asked for, so it was not shown. Report the code and the tool you called; do not retry against a different car.',
  DOMAIN_MISMATCH: 'The response was labelled a different domain than the one asked for, so it was not shown. Report the code and the tool you called.',
  UNKNOWN_DOMAIN: 'That Domain is not in the registry. list_domains enumerates every one as kind/name.',
  DELEGATION_NOT_ALLOWED: 'List the account in POLESTAR_DELEGATED_ACCOUNT_IDS to let callers switch to it; the API does not reject an unknown delegation, so this server checks it.',
  LOCATION_DISALLOWED: 'Position is disabled by POLESTAR_ALLOW_LOCATION=false and the vehicle was never queried. Enable it only at the owner\u2019s request.',
  BAD_RESPONSE: 'The API returned an unexpected body; retry once, then report the code and the tool you called.',
  AUTH_ERROR: 'The token endpoint refused the credential. Check POLESTAR_CLIENT_ID and POLESTAR_CLIENT_SECRET, and whether the secret was rotated.',
  TRANSPORT_TIMEOUT: 'The request did not complete in time; the API can be slow, retry once.',
  TRANSPORT_NETWORK: 'No route to the API; check connectivity before retrying.',
  RATE_LIMIT_EXCEEDED: 'The daily call budget is spent; retry after the reset reported by polestar_status.',
  RATE_LIMIT_MINUTE: 'The API also allows only 100 requests/minute. The server waits this out on its own; if you see it, slow the polling rate or lower POLESTAR_BUDGET_PER_MINUTE.',
  INTERNAL_ERROR: 'Something failed inside this server rather than upstream. Report the code and the tool you called.',
};

/**
 * Advice for the codes the Data Portal itself answers with. Two of these came from
 * live probes rather than documentation: 403 is `AUTHZ_VIN_UNAUTHORIZED` (no access
 * to that VIN, and the same answer for a malformed one) or `AUTHZ_CLIENT_ID_MISMATCH`
 * (x-client-id carried the OAuth client id). Neither is a scope problem; a 401 is
 * what a bad credential looks like.
 */
const UPSTREAM_HINTS: Record<string, string> = {
  AUTHZ_VIN_UNAUTHORIZED: 'This credential cannot see that VIN. Call list_vehicles for the authorized set; the API answers the same way for a malformed VIN, so check the characters too.',
  AUTHZ_CLIENT_ID_MISMATCH: 'x-client-id carried the OAuth client id. Set POLESTAR_ACCOUNT_ID to the Account ID shown next to the Base URL in the Data Portal.',
  AUTHZ_SCOPE_MISSING: 'The token is missing a scope for this domain; check POLESTAR_SCOPES.',
  VALIDATION_INVALID_PARAMETER: 'A required header or path parameter was rejected; verify POLESTAR_ACCOUNT_ID and the VIN.',
  VALIDATION_RESOURCE_NOT_FOUND: 'That domain does not exist on this API version; list the supported names rather than retrying.',
  UNAUTHORIZED: 'Credential rejected even after a fresh token; it may have been revoked or rotated.',
};

/** The text of a result, for a surface that can send nothing else (MCP resources). */
export function resultText(result: ToolResult): string {
  return result.content.map((c) => c.text).join('\n');
}

/** One text rendering of a failure, shared by tools and by the resource surface. */
export function describeError(err: unknown): string {
  return describeFailure(toFailure(err));
}

/**
 * Apply POLESTAR_REDACT_VIN to a failure envelope.
 *
 * The VIN is masked in the rendered text and in the structured `message` and
 * `hint`, because a failure can echo a caller argument (`INVALID_VIN`) or carry
 * an upstream message that quotes the vehicle. `requestId` and `code` are left
 * alone: the requestId is the handle support acts on, and a code is not data.
 * Successes are untouched, which keeps the documented `raw: true` exception.
 */
export function maskFailureResult(result: ToolResult, redact: boolean): ToolResult {
  if (!redact || result.isError !== true) return result;
  const content = result.content.map((block) =>
    block.type === 'text' ? { ...block, text: maskVinsInText(block.text, true) } : block,
  );
  const structured = result.structuredContent;
  const maskedStructured =
    structured === undefined
      ? undefined
      : {
          ...structured,
          ...(typeof structured.message === 'string' ? { message: maskVinsInText(structured.message, true) } : {}),
          ...(typeof structured.hint === 'string' ? { hint: maskVinsInText(structured.hint, true) } : {}),
        };
  return {
    ...result,
    content,
    ...(maskedStructured === undefined ? {} : { structuredContent: maskedStructured }),
  };
}

/**
 * Failures travel as failures: `isError: true` plus a structured copy carrying
 * code, status, requestId and the advice for that code. Returning an error as
 * ordinary text makes the model weigh it the same as data, and the requestId is
 * the only handle Polestar support acts on, so it belongs in a field.
 *
 * The hint is said twice on purpose, once in the text a model reads and once in
 * the field a client branches on. It used to be said three times because
 * `message` was the whole content block, hint included; `message` is the refusal
 * alone now. A hint may name the requestId only when the failure actually carries
 * one: `INVALID_VIN` and the other local refusals have no upstream handle, so
 * asking for one sends the caller looking for something that does not exist.
 */
export function errorResult(err: unknown, extraHint?: string): ToolResult {
  const failure = toFailure(err);
  const code = failure.code;
  const hasRequestId = typeof failure.requestId === 'string';
  const hint =
    extraHint
    ?? (failure.minted !== undefined ? MINTED_HINTS[failure.minted] : undefined)
    ?? UPSTREAM_HINTS[code]
    ?? (hasRequestId
      ? 'Report the requestId with the tool you called; this code is not one this server documents.'
      : 'Report the code and the tool you called; this code is not one this server documents.');
  const message = describeFailure(failure);
  const text = `${message}\nHint: ${hint}`;
  // The same envelope as a success, with ok:false, so a consumer needs one parser
  // rather than one per outcome. `message` is the refusal without the hint, which
  // is what makes it different from the content text and worth sending at all.
  const structured: Record<string, unknown> = { ok: false, message, code };
  if (typeof failure.httpStatus === 'number') structured.httpStatus = failure.httpStatus;
  if (hasRequestId) structured.requestId = failure.requestId;
  structured.hint = hint;
  return {
    content: [{ type: 'text', text }],
    isError: true,
    structuredContent: structured,
  };
}

/**
 * The `extra` object the SDK hands a tool handler. Verified against the real
 * runtime shape rather than assumed: `{ sessionId, mcpReq, http }`, where
 * `mcpReq` carries `elicitInput`, `requestState` and `signal`. Capabilities are
 * NOT exposed on it, so the only reliable way to learn whether this client can
 * be asked is to ask and be told.
 */
export type ToolContext = {
  sessionId?: string;
  mcpReq?: {
    elicitInput?: (params: Record<string, unknown>) => Promise<{ action?: string; content?: Record<string, unknown> }>;
    inputResponses?: Record<string, unknown>;
  };
};
