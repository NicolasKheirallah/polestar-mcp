import { acceptedContent } from '@modelcontextprotocol/server';
import { PolestarApiError, type PolestarClient } from './client.js';
import type { DomainSpec } from './domains.js';
import { formatAge, maskVin, observedAtMs, summarizeDomain, vinLabel } from './format.js';
import { errorResult, resultText, text, type ReadArgs, type ToolContext, type ToolDeps, type ToolResult } from './tool-output.js';

/** One Domain, as the registry row names it. `DomainSpec` satisfies this. */
export type DomainTarget = Pick<DomainSpec, 'kind' | 'name'>;

/** A Domain read also needs its OAuth scope, so a 403 can say which one is missing. */
export interface DomainReader extends DomainTarget {
  scope: string;
}

/**
 * A Vehicle, and the client every read for it goes out under.
 *
 * The delegated identity is settled once, before any read, and then carried by
 * the client itself. Keeping `deps.client` and a separate `active` in one scope is
 * how a read once escaped the delegation it was given.
 */
export interface VehicleScope {
  vin: string;
  /** The VIN as prose prints it: masked when POLESTAR_REDACT_VIN is on. */
  label: string;
  client: PolestarClient;
  /** Read one Domain of this Vehicle. Null when the car reports no such data. */
  read(domain: DomainTarget): Promise<Record<string, unknown> | null>;
}

/**
 * Which Vehicle a call is about.
 *
 * Failure travels as a finished result rather than as an exception, because every
 * tool's failure path is the same one: eight call sites used to wrap the same
 * resolve in the same catch and produce the same error result by hand.
 */
export type VehicleOutcome = { ok: true; vehicle: VehicleScope } | { ok: false; result: ToolResult };

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

/**
 * Resolve which vehicle a call is about. One vehicle is implicit; none is an
 * error; several used to be an error too, which pushed the model to go fetch a
 * VIN list and retry. With the 2026-07-28 multi-round-trip flow the server can
 * instead ask the client to pick, and continue on the retry with the answer.
 * `elicitInput()` is deprecated and throws on this protocol revision.
 *
 * This is the one place that asks. Four of the eight tools that take a `vin` used
 * to skip it and fail with AMBIGUOUS_VIN instead, so whether a multi-car
 * credential got a question or an error depended on which tool the model happened
 * to call.
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

/**
 * Resolve the Vehicle, applying the caller's delegation first.
 *
 * `requestKey` names the pending question in the client's multi-round-trip state,
 * so it has to be stable across the two attempts of one call and unique per tool.
 */
export async function vehicleFor(
  deps: ToolDeps,
  ctx: ToolContext | undefined,
  args: ReadArgs,
  requestKey: string,
): Promise<VehicleOutcome> {
  try {
    const scoped: ToolDeps = { ...deps, client: clientFor(deps, args.delegated_account_id) };
    const { vin } = await resolveVinOrAsk(scoped, ctx, args.vin, requestKey);
    const client = scoped.client;
    return {
      ok: true,
      vehicle: {
        vin,
        label: vinLabel(vin, deps.redactVin, deps.vehicleLabels),
        client,
        read: (domain: DomainTarget) => client.domain(vin, domain.kind, domain.name),
      },
    };
  } catch (err) {
    return { ok: false, result: errorResult(err) };
  }
}

/**
 * The one sentence for a Domain a car does not report.
 *
 * It was written four ways across nine tools: this sentence, "No exterior data
 * available for …", "No health data available…", and "No battery data available,
 * cannot estimate." Four spellings of one fact meant four places to notice it, and
 * a caller reading two tools could not tell whether they disagreed. A tool whose
 * consequence is worth naming adds it as a second sentence; the fact itself is
 * stated here, in the wording docs/tools-reference.md documents.
 */
export function noData(vehicle: VehicleScope, domain: DomainTarget, consequence?: string): ToolResult {
  const sentence = `No ${domain.name} data is available for vehicle ${vehicle.label} (the API returned DATA_NOT_AVAILABLE, this vehicle does not report this domain).`;
  return text(consequence === undefined ? sentence : `${sentence} ${consequence}`);
}

/**
 * Read several Domains of one Vehicle at once, under the caller's own names.
 *
 * One round of concurrent reads, and the payloads come back keyed by those names,
 * so a tool body is its own prose and nothing else: no path, no VIN, no null
 * check, no catch.
 */
export async function readDomains<K extends string>(
  vehicle: VehicleScope,
  domains: Record<K, DomainTarget>,
): Promise<Record<K, Record<string, unknown> | null>> {
  const names = Object.keys(domains) as K[];
  const payloads = await Promise.all(names.map((name) => vehicle.read(domains[name])));
  const out = {} as Record<K, Record<string, unknown> | null>;
  names.forEach((name, index) => {
    out[name] = payloads[index] ?? null;
  });
  return out;
}

/**
 * What one Domain read produced, before a surface wraps it.
 *
 * The tool surface turns this into a result with a structured envelope; the
 * resource surface turns the same text into resource contents. One read, so a
 * subscribed resource and the tool it mirrors cannot answer the same question
 * differently. The resource handler used to have its own shorter read, which had
 * already lost the age header, the owner labels, the redaction and the delegation.
 */
export interface DomainReading {
  vin: string;
  /** The rendered text both surfaces send. */
  text: string;
  /** The raw payload, when the caller asked for it or when there is no summary. */
  data?: Record<string, unknown> | undefined;
  ageSeconds?: number | undefined;
}

export type DomainReadOutcome = { ok: true; reading: DomainReading } | { ok: false; result: ToolResult };

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
export async function readDomain(
  deps: ToolDeps,
  domain: DomainReader,
  args: ReadArgs,
  ctx: ToolContext | undefined,
): Promise<DomainReadOutcome> {
  const { kind, name, scope } = domain;
  const found = await vehicleFor(deps, ctx, args, `pick-vehicle-${name}`);
  if (!found.ok) return { ok: false, result: found.result };
  const vehicle = found.vehicle;

  let data: Record<string, unknown> | null;
  try {
    data = await vehicle.read(domain);
  } catch (err) {
    return {
      ok: false,
      result: errorResult(
        err,
        (err as PolestarApiError)?.httpStatus === 403 ? `this domain needs the OAuth scope \`${scope}\` on the credential` : undefined,
      ),
    };
  }
  // A car that reports nothing is a normal answer, not a failure: the reading comes
  // back ok, carrying the shared absence sentence rather than an error.
  if (data === null) {
    return { ok: true, reading: { vin: vehicle.vin, text: resultText(noData(vehicle, domain)) } };
  }

  const nowMs = deps.nowMs?.() ?? Date.now();
  const observed = observedAtMs(data);
  const age = observed !== undefined ? `data observed ${formatAge(observed, nowMs)}` : 'freshness unknown';
  const header = `Vehicle ${vehicle.label}, ${kind}/${name} (${age})`;

  const summaryLines = summarizeDomain(name, data, deps.units);
  const sections = [header];
  if (summaryLines !== null) sections.push(...summaryLines);
  const includeRaw = args.raw === true || summaryLines === null;
  if (includeRaw) {
    sections.push('', 'Raw payload:', JSON.stringify(data, null, 2));
  }
  return {
    ok: true,
    reading: {
      vin: vehicle.vin,
      text: sections.join('\n'),
      ...(includeRaw ? { data } : {}),
      ...(observed !== undefined ? { ageSeconds: Math.max(0, Math.round((nowMs - observed) / 1000)) } : {}),
    },
  };
}

/** The same read, wrapped in the tool result envelope. */
export async function readDomainFormatted(
  deps: ToolDeps,
  domain: DomainReader,
  args: ReadArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const outcome = await readDomain(deps, domain, args, ctx);
  if (!outcome.ok) return outcome.result;
  const { vin, text: body, data, ageSeconds } = outcome.reading;
  // structuredContent mirrors what the text carries: putting the whole payload
  // in the envelope as well would quietly re-add the tokens that the compact
  // summary exists to save, since clients forward structure to the model too.
  return text(body, {
    // The envelope goes to the model alongside the text, so it must obey
    // POLESTAR_REDACT_VIN too; masking only the prose left the identifier in
    // the machine-readable half of the same result.
    vin: maskVin(vin, deps.redactVin),
    tool: `get_${domain.name.replace(/-/g, '_')}`,
    ...(ageSeconds !== undefined ? { ageSeconds } : {}),
    ...(data !== undefined ? { data } : {}),
  });
}
