/**
 * The Domain tools: one humanized read per registry entry, plus discovery and
 * the support matrix. The registry itself is in domains.ts; this module turns it
 * into callable specs.
 */
import type { DomainKind, PolestarClient } from './client.js';
import { domainView, type DomainView } from './domain-view.js';
import { toFailure } from './failure.js';
import { formatAge, maskVin, observedAtMs } from './format.js';
import {
  delegatedAccountArg,
  errorResult,
  rawArg,
  text,
  vinArg,
  withData,
  type ReadArgs,
  type ToolDeps,
  type VinArgs,
} from './tool-output.js';
import { clientFor, readDomainFormatted, vehicleFor } from './vehicle-read.js';
import { DOMAINS, domainPath, toolName } from './domains.js';
import type { ToolSpec } from './tools.js';

/** list_vehicles reads a credential's vehicles, so it takes the account selector too. */
type ListVehiclesArgs = { delegated_account_id?: string };

/**
 * The support-matrix tool, named and described in one place.
 *
 * The description is part of the release documentation and the routing surface,
 * so the spec reads these fields rather than carrying a second copy a docs
 * change could miss. `list_vehicle_domains` is deliberately not a `get_*` name:
 * it answers a car-level question, not a Domain read.
 */
export const LIST_VEHICLE_DOMAINS = {
  name: 'list_vehicle_domains',
  title: 'List what the car reports',
  description:
    'Report which of the 15 data domains this vehicle reports: one line per domain as reported, absent or failed, with the data age when reported. Costs up to one cached read per domain on a cold cache; use it before asking questions a car may not answer.',
} as const;

const DOMAIN_STATUS = ['reported', 'absent', 'disallowed', 'failed'] as const;
type DomainStatus = (typeof DOMAIN_STATUS)[number];

/** One row of the support matrix, also the shape of `data.domains[]`. */
interface DomainMatrixEntry {
  kind: DomainKind;
  name: string;
  tool: string;
  status: DomainStatus;
  observedAt?: string;
  ageSeconds?: number;
  code?: string;
  httpStatus?: number;
}

interface DomainMatrixCounts {
  total: number;
  reported: number;
  absent: number;
  failed: number;
  disallowed: number;
}

/**
 * Wrap a client so the payload of the Domain read it performs is observed.
 *
 * A Domain tool goes through `readDomainFormatted`, the one render path, which
 * keeps the payload only when `raw: true`. Attaching a typed view by calling the
 * client a second time would spend a second read on a cache miss. The wrapper
 * records the answer of the same call instead: one transport request, one
 * history record, one render path, and an honest typed view.
 */
function clientCapturingDomain(
  base: PolestarClient,
  capture: (payload: Record<string, unknown>) => void,
): PolestarClient {
  const wrap = (client: PolestarClient): PolestarClient =>
    ({
      vehicles: () => client.vehicles(),
      resolveVin: (vin?: string) => client.resolveVin(vin),
      domain: async (vin: string, kind: DomainKind, name: string) => {
        const payload = await client.domain(vin, kind, name);
        if (payload !== null) capture(payload);
        return payload;
      },
      forDelegation: (account: string | undefined) => wrap(client.forDelegation(account)),
    }) as unknown as PolestarClient;
  return wrap(base);
}

function matrixLine(entry: DomainMatrixEntry, nowMs: number): string {
  const where = `${entry.kind}/${entry.name}`;
  switch (entry.status) {
    case 'reported':
      return `  ${where}: reported (${
        entry.ageSeconds === undefined ? 'age unknown' : formatAge(nowMs - entry.ageSeconds * 1000, nowMs)
      })`;
    case 'absent':
      return `  ${where}: absent (DATA_NOT_AVAILABLE, which is not an error)`;
    case 'disallowed':
      return `  ${where}: disallowed (POLESTAR_ALLOW_LOCATION=false, so no position request was sent)`;
    case 'failed':
      return `  ${where}: failed (${entry.code ?? 'unknown'}${
        entry.httpStatus === undefined ? '' : `, HTTP ${entry.httpStatus}`
      })`;
  }
}

/**
 * list_vehicles, list_domains, the support matrix, and one humanized get_* tool
 * per Domain, all derived from the table above. These are values: the registrar
 * hands them to the SDK, and a test can call `spec.run(args, ctx)` on the same
 * function.
 */
export function domainToolSpecs(deps: ToolDeps): ToolSpec[] {
  return [
    {
      name: 'list_vehicles',
      title: 'List vehicles',
      description: 'List the VINs this Polestar Data Portal credential is authorized to access.',
      args: { ...delegatedAccountArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (args: ListVehiclesArgs) => {
        try {
          // The VIN list is the most identity-sensitive read this server makes, so
          // a delegated credential must be able to name the account it is listing.
          const client = clientFor(deps, args?.delegated_account_id);
          const vehicles = await client.vehicles();
          if (vehicles.length === 0) {
            return text('This credential is not authorized for any vehicle.', { data: { count: 0, vehicles: [] } });
          }
          const entries = vehicles.map((v) => ({
            vin: maskVin(v, deps.redactVin),
            ...(deps.vehicleLabels[v.toUpperCase()] !== undefined ? { label: deps.vehicleLabels[v.toUpperCase()] } : {}),
          }));
          const lines = entries.map((e) => `  - ${e.label !== undefined ? e.label + ' (' + e.vin + ')' : e.vin}`);
          const naming = deps.redactVin && Object.keys(deps.vehicleLabels).length === 0
            ? 'Set POLESTAR_VEHICLE_LABELS="VIN=My Car" to name your cars without printing identifiers.'
            : undefined;
          const block = [`Authorized vehicles (${vehicles.length}):`, ...lines, ...(naming !== undefined ? [naming] : [])];
          return text(block.join('\n'), {
            data: {
              count: entries.length,
              vehicles: entries,
              note: 'The M2M contract returns VINs only: model, model year and registration number exist on the consumer app API, not here. Set POLESTAR_VEHICLE_LABELS="VIN=My Car" to give each a name.',
            },
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: 'list_domains',
      title: 'List data domains',
      description:
        'Every domain this server reads, with its endpoint, OAuth scope and tool name. Answer from here rather than guessing a domain name: an unknown domain is a 404 VALIDATION_RESOURCE_NOT_FOUND from the API, which is a different thing from a vehicle reporting no data.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async () =>
        text(
          [
            `${DOMAINS.length} domains (read-only; a domain a vehicle does not report answers DATA_NOT_AVAILABLE, which is not an error):`,
            ...DOMAINS.map((d) => `  ${toolName(d)}, ${domainPath(d.kind, d.name)} [scope ${d.scope}]`),
          ].join('\n'),
        ),
    },
    {
      name: LIST_VEHICLE_DOMAINS.name,
      title: LIST_VEHICLE_DOMAINS.title,
      description: LIST_VEHICLE_DOMAINS.description,
      args: { ...vinArg, ...delegatedAccountArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (args: VinArgs, ctx) => {
        try {
          const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-domains');
          if (!found.ok) return found.result;
          const nowMs = deps.nowMs?.() ?? Date.now();
          const entries = await Promise.all(
            DOMAINS.map(async (domain): Promise<DomainMatrixEntry> => {
              const base = { kind: domain.kind, name: domain.name, tool: toolName(domain) };
              try {
                const payload = await found.vehicle.read(domain);
                if (payload === null) {
                  // DATA_NOT_AVAILABLE is a normal state of a car, not a failure.
                  return { ...base, status: 'absent', code: 'DATA_NOT_AVAILABLE' };
                }
                const observed = observedAtMs(payload);
                return {
                  ...base,
                  status: 'reported',
                  ...(observed === undefined
                    ? {}
                    : {
                        observedAt: new Date(observed).toISOString(),
                        ageSeconds: Math.max(0, Math.round((nowMs - observed) / 1000)),
                      }),
                };
              } catch (err) {
                const failure = toFailure(err);
                // POLESTAR_ALLOW_LOCATION=false refuses telemetry/location inside
                // PolestarClient before any transport call, so the attempt reads
                // nothing; it is a policy state, not a failure of the car or API.
                const status: DomainStatus = failure.code === 'LOCATION_DISALLOWED' ? 'disallowed' : 'failed';
                return {
                  ...base,
                  status,
                  code: failure.code,
                  ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
                };
              }
            }),
          );
          const counts: DomainMatrixCounts = {
            total: DOMAINS.length,
            reported: entries.filter((e) => e.status === 'reported').length,
            absent: entries.filter((e) => e.status === 'absent').length,
            failed: entries.filter((e) => e.status === 'failed').length,
            disallowed: entries.filter((e) => e.status === 'disallowed').length,
          };
          const lines = [
            `Vehicle ${found.vehicle.label}: ${counts.reported} of ${counts.total} domains reported.`,
            ...entries.map((entry) => matrixLine(entry, nowMs)),
            '',
            'Absent means the car does not report that domain; it is a normal state, not an error.',
            'A failed row is an error: quote its code when reporting a problem.',
            'This matrix costs one cached read per domain on a cold cache; repeated calls are served from cache.',
          ];
          const shownVin = maskVin(found.vehicle.vin, deps.redactVin);
          return withData(
            lines.join('\n'),
            {
              vin: shownVin,
              counts,
              observedAt: new Date(nowMs).toISOString(),
              domains: entries,
            },
            { vin: shownVin },
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    ...DOMAINS.map((domain): ToolSpec => ({
      name: toolName(domain),
      title: `Get ${domain.name}`,
      // Endpoint and scope are operator facts: list_domains answers them once,
      // and repeating them on 15 model-facing descriptions cost about 1.4 KB of
      // every session's tool list without adding a routing cue.
      description: domain.description,
      args: { ...vinArg, ...rawArg, ...delegatedAccountArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (args, ctx) => {
        let payload: Record<string, unknown> | null = null;
        const result = await readDomainFormatted(
          { ...deps, client: clientCapturingDomain(deps.client, (data) => { payload = data; }) },
          domain,
          args as ReadArgs,
          ctx,
        );
        if (result.structuredContent?.ok !== true) return result;
        // `raw: true` already put the untouched payload in `data`; that promise
        // wins over the compact view. Every other success carries the view.
        if (result.structuredContent.data !== undefined) return result;
        result.structuredContent.data = payload === null ? { reported: false } : domainView(domain.name, payload);
        return result;
      },
    })),
  ];
}

/** The typed data shape one Domain tool documents for `structuredContent.data`. */
export type { DomainView };
