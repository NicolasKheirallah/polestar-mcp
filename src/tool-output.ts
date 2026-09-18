import { z } from 'zod';
import { acceptedContent } from '@modelcontextprotocol/server';
import { PolestarApiError, type DomainKind, type PolestarClient } from './client.js';
import { formatAge, maskVin, observedAtMs, summarizeDomain, vinLabel, type Units } from './format.js';
import { describeFailure, toFailure, type MintedCode } from './failure.js';

export const vinArg = {
  vin: z
    .string()
    .optional()
    .describe(
      'Vehicle Identification Number. Optional when the credential has exactly one vehicle, omit it and the only vehicle is used.',
    ),
};

/** The arguments a tool that reads one Vehicle accepts. */
export interface VinArgs {
  vin?: string;
}

/** A domain read: the Vehicle, whether to include the raw payload, and an optional delegation. */
export interface ReadArgs extends VinArgs {
  raw?: boolean;
  delegated_account_id?: string;
}

export const rawArg = {
  raw: z
    .boolean()
    .optional()
    .describe(
      'Return the full raw API payload instead of (or after) the humanized summary. Unchanged upstream content: it carries the VIN even when POLESTAR_REDACT_VIN is on.',
    ),
};

/** Per-call account selector for third-party credentials; allowlist-checked. */
export const delegatedAccountArg = {
  delegated_account_id: z
    .string()
    .optional()
    .describe('Third-party credentials only: read the shared vehicles of this account for this call. Must be listed in POLESTAR_DELEGATED_ACCOUNT_IDS.'),
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
  nowMs?: () => number;
}

/**
 * The one output envelope every tool declares. With `outputSchema` set the SDK
 * validates each result against it, so "this tool returns text a model has to
 * parse" becomes a checked contract: clients branch on `ok` and read `data`
 * structurally, and a result that drifts from the schema fails loudly instead
 * of quietly changing shape under every consumer. `message` repeats the text
 * block, so agents that only read content lose nothing.
 */
export const resultShape = {
  ok: z.boolean().describe('False when the call produced no data.'),
  message: z.string().describe('Result text, identical to the content block.'),
  tool: z.string().optional().describe('Tool that produced this result.'),
  vin: z.string().optional().describe('Vehicle the result is about, masked when POLESTAR_REDACT_VIN is on.'),
  data: z.unknown().optional().describe('Structured payload; shape documented per tool.'),
  ageSeconds: z.number().nonnegative().optional().describe('Staleness of the underlying telemetry.'),
  code: z.string().optional().describe('Machine-readable error code when ok is false.'),
  httpStatus: z.number().optional().describe('Upstream HTTP status when ok is false.'),
  requestId: z.string().optional().describe('Upstream request id, the handle support needs.'),
  hint: z.string().optional().describe('Actionable guidance when ok is false.'),
};

/** Standard text content wrapper, carrying the matching structured envelope. */
export function text(
  content: string,
  extra?: Partial<{ vin: string; data: unknown; ageSeconds: number; tool: string }>,
): ToolResult {
  return {
    content: [{ type: 'text', text: content }],
    structuredContent: { ok: true, message: content, ...extra },
  };
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
  VIN_MISMATCH: 'The response was labelled a different vehicle than the one asked for, so it was not shown. Report the requestId; do not retry against a different car.',
  DOMAIN_MISMATCH: 'The response was labelled a different domain than the one asked for, so it was not shown. Report the requestId.',
  DELEGATION_NOT_ALLOWED: 'List the account in POLESTAR_DELEGATED_ACCOUNT_IDS to let callers switch to it; the API does not reject an unknown delegation, so this server checks it.',
  LOCATION_DISALLOWED: 'Position is disabled by POLESTAR_ALLOW_LOCATION=false and the vehicle was never queried. Enable it only at the owner\u2019s request.',
  BAD_RESPONSE: 'The API returned an unexpected body; retry once, then report the requestId.',
  AUTH_ERROR: 'The token endpoint refused the credential. Check POLESTAR_CLIENT_ID and POLESTAR_CLIENT_SECRET, and whether the secret was rotated.',
  TRANSPORT_TIMEOUT: 'The request did not complete in time; the API can be slow, retry once.',
  TRANSPORT_NETWORK: 'No route to the API; check connectivity before retrying.',
  RATE_LIMIT_EXCEEDED: 'The daily call budget is spent; retry after the reset reported by polestar_status.',
  RATE_LIMIT_MINUTE: 'The API also allows only 100 requests/minute. The server waits this out on its own; if you see it, slow the polling rate or lower POLESTAR_BUDGET_PER_MINUTE.',
  INTERNAL_ERROR: 'Something failed inside this server rather than upstream. Report the requestId and the tool you called.',
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

/**
 * Applies a caller-supplied delegated account, refusing anything outside the
 * operator's allowlist. The check lives here because the gateway answers 200 for
 * an unknown `x-delegated-account-id` rather than rejecting it: an unvalidated
 * argument would quietly serve a different account's vehicles and look like an
 * ordinary result.
 */
export function clientFor(deps: ToolDeps, delegatedAccountId: string | undefined): PolestarClient {
  if (delegatedAccountId === undefined || delegatedAccountId === '') return deps.client;
  if (!deps.delegatedAccounts.includes(delegatedAccountId)) {
    throw new PolestarApiError(
      'DELEGATION_NOT_ALLOWED',
      `delegated_account_id ${JSON.stringify(delegatedAccountId)} is not in POLESTAR_DELEGATED_ACCOUNT_IDS, so it was not sent.`,
      403,
    );
  }
  return deps.client.forDelegation(delegatedAccountId);
}

/** One text rendering of a failure, shared by tools and by the resource surface. */
export function describeError(err: unknown): string {
  return describeFailure(toFailure(err));
}

/**
 * Failures travel as failures: `isError: true` plus a structured copy carrying
 * code, status, requestId and the advice for that code. Returning an error as
 * ordinary text makes the model weigh it the same as data, and the requestId is
 * the only handle Polestar support acts on, so it belongs in a field.
 */
export function errorResult(err: unknown, extraHint?: string): ToolResult {
  const failure = toFailure(err);
  const code = failure.code;
  const hint =
    extraHint
    ?? (failure.minted !== undefined ? MINTED_HINTS[failure.minted] : undefined)
    ?? UPSTREAM_HINTS[code]
    ?? 'Report the requestId with the tool you called; this code is not one this server documents.';
  const message = describeFailure(failure);
  const text = `${message}\nHint: ${hint}`;
  // The same envelope as a success, with ok:false, so a consumer needs one parser
  // rather than one per outcome.
  const structured: Record<string, unknown> = { ok: false, message: text, code };
  if (typeof failure.httpStatus === 'number') structured.httpStatus = failure.httpStatus;
  if (typeof failure.requestId === 'string') structured.requestId = failure.requestId;
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

/**
 * Resolve which vehicle a call is about. One vehicle is implicit; none is an
 * error; several used to be an error too, which pushed the model to go fetch a
 * VIN list and retry. With the 2026-07-28 multi-round-trip flow the server can
 * instead ask the client to pick, and continue on the retry with the answer 
 * `elicitInput()` is deprecated and throws on this protocol revision.
 */
export async function resolveVinOrAsk(
  deps: ToolDeps,
  ctx: ToolContext | undefined,
  vinInput: string | undefined,
  requestKey: string,
): Promise<{ vin: string }> {
  try {
    return { vin: await deps.client.resolveVin(vinInput) };
  } catch (err) {
    const ambiguous = (err as PolestarApiError)?.code === 'AMBIGUOUS_VIN';
    if (!ambiguous || ctx?.mcpReq?.elicitInput === undefined) throw err;
    const answer = acceptedContent<{ vin?: string }>(ctx.mcpReq.inputResponses, requestKey);
    if (answer?.vin !== undefined) {
      // Client input is untrusted: resolveVin still validates it.
      return { vin: await deps.client.resolveVin(answer.vin) };
    }
    const vins = await deps.client.vehicles();
    let elicited: { action?: string; content?: Record<string, unknown> } | undefined;
    try {
      elicited = await ctx.mcpReq.elicitInput({
        message: `This credential can see ${vins.length} vehicles. Which one?`,
        requestedSchema: {
          type: 'object',
          properties: { vin: { type: 'string', enum: vins, description: 'Choose the vehicle to read.' } },
          required: ['vin'],
        },
      });
    } catch {
      // The client never declared the elicitation capability (or is on a
      // protocol revision without this channel). Fall back to the same
      // actionable error an un-askable caller would want, rather than
      // surfacing a protocol refusal.
      throw err;
    }
    const chosen = elicited?.action === 'accept' ? elicited.content?.vin : undefined;
    if (typeof chosen === 'string') return { vin: await deps.client.resolveVin(chosen) };
    throw new PolestarApiError(
      'VIN_NOT_CHOSEN',
      `No vehicle was chosen. This credential can see: ${vins.join(', ')}`,
      400,
    );
  }
}

/** The slice of a registry row a domain read needs. `DomainSpec` satisfies it. */
export interface DomainReader {
  kind: DomainKind;
  name: string;
  scope: string;
}

/**
 * One domain read, rendered for an agent: a humanized summary plus data age, with
 * the untouched API payload appended when `raw` is requested. A 403 gains a scope
 * hint because the M2M credential is scoped per domain and the raw message never
 * says which scope was missing.
 *
 * The Domain arrives as the registry row rather than as three loose strings: with
 * the positional form a caller could transpose `kind`, `name` and `scope` and
 * still type-check.
 */
export async function readDomainFormatted(
  deps: ToolDeps,
  domain: DomainReader,
  args: ReadArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { vin: vinInput, raw, delegated_account_id: delegatedAccountId } = args;
  const { kind, name, scope } = domain;
  try {
    // One client for the whole call: the delegated identity is resolved once and
    // every request after it goes out under that identity. Holding `deps.client`
    // and a separate `active` in the same scope is how a read silently escaped
    // the delegation.
    const scoped: ToolDeps = { ...deps, client: clientFor(deps, delegatedAccountId) };
    const picked = await resolveVinOrAsk(scoped, ctx, vinInput, `pick-vehicle-${name}`);
    const vin = picked.vin;
    const data = await scoped.client.domain(vin, kind, name);
    const label = vinLabel(vin, deps.redactVin, deps.vehicleLabels);

    if (data === null) {
      return text(
        `No ${name} data is available for vehicle ${label} (the API returned DATA_NOT_AVAILABLE, this vehicle does not report this domain).`,
      );
    }

    const nowMs = deps.nowMs?.() ?? Date.now();
    const observed = observedAtMs(data);
    const age = observed !== undefined ? `data observed ${formatAge(observed, nowMs)}` : 'freshness unknown';
    const header = `Vehicle ${label}, ${kind}/${name} (${age})`;

    const summaryLines = summarizeDomain(name, data, deps.units);
    const sections = [header];
    if (summaryLines !== null) sections.push(...summaryLines);
    const includeRaw = raw === true || summaryLines === null;
    if (includeRaw) {
      sections.push('', 'Raw payload:', JSON.stringify(data, null, 2));
    }
    // structuredContent mirrors what the text carries: putting the whole payload
    // in the envelope as well would quietly re-add the tokens that the compact
    // summary exists to save, since clients forward structure to the model too.
    return text(sections.join('\n'), {
      // The envelope goes to the model alongside the text, so it must obey
      // POLESTAR_REDACT_VIN too; masking only the prose left the identifier in
      // the machine-readable half of the same result.
      vin: maskVin(vin, deps.redactVin),
      tool: `get_${name.replace(/-/g, '_')}`,
      ...(observed !== undefined ? { ageSeconds: Math.max(0, Math.round((nowMs - observed) / 1000)) } : {}),
      ...(includeRaw ? { data } : {}),
    });
  } catch (err) {
    return errorResult(err, (err as PolestarApiError)?.httpStatus === 403 ? `this domain needs the OAuth scope \`${scope}\` on the credential` : undefined);
  }
}

