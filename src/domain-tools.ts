/**
 * The Domain tools: one humanized read per registry entry, plus discovery.
 * The registry itself is in domains.ts; this module turns it into callable specs.
 */
import { delegatedAccountArg, errorResult, rawArg, readDomainFormatted, text, vinArg, type ReadArgs, type ToolDeps } from './tool-output.js';
import { maskVin } from './format.js';
import { DOMAINS, domainPath, toolName } from './domains.js';
import type { ToolSpec } from './tools.js';

/**
 * list_vehicles, list_domains, and one humanized get_* tool per Domain, all
 * derived from the table above. These are values: the registrar hands them to
 * the SDK, and a test can call `spec.run(args, ctx)` on the same function.
 */
export function domainToolSpecs(deps: ToolDeps): ToolSpec[] {
  return [
    {
      name: 'list_vehicles',
      title: 'List vehicles',
      description: 'List the VINs this Polestar Data Portal credential is authorized to access.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async () => {
        try {
          const vehicles = await deps.client.vehicles();
          if (vehicles.length === 0) return text('This credential is not authorized for any vehicle.');
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
    ...DOMAINS.map((domain): ToolSpec => ({
      name: toolName(domain),
      title: `Get ${domain.name}`,
      description: `${domain.description} (M2M endpoint: ${domainPath(domain.kind, domain.name)}, scope ${domain.scope}).`,
      args: { ...vinArg, ...rawArg, ...delegatedAccountArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: (args, ctx) => readDomainFormatted(deps, domain, args as ReadArgs, ctx),
    })),
  ];
}
