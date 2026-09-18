/**
 * Print the tool registry as JSON.
 *
 * The docs gate used to rebuild this list by regexing the *source text* of the
 * registration calls and of the DOMAINS table, which made formatting into an
 * accidental interface. Building the specs needs no wiring, no handler runs 
 * so this is the same list the server registers, derived rather than restated.
 *
 *   node --import tsx scripts/list-tools.ts            # ["get_battery", ...]
 *   node --import tsx scripts/list-tools.ts --detail    # [{name, title, readOnlyHint, from}]
 */
import { domainToolSpecs } from '../src/domain-tools.js';
import { aggregateToolSpecs } from '../src/aggregate-tools.js';
import { advisorToolSpecs } from '../src/advisor-tools.js';
import { historyToolSpecs } from '../src/history-tools.js';
import { systemToolSpecs } from '../src/system-tools.js';
import { toolNames, type ToolSpec } from '../src/tools.js';
import type { ToolDeps } from '../src/tool-output.js';

// No handler executes while building specs, so the wiring can stay a placeholder.
const deps = {
  client: {},
  redactVin: false,
  vehicleLabels: {},
  delegatedAccounts: [],
  units: 'km',
} as unknown as ToolDeps;

const families: Array<[string, ToolSpec[]]> = [
  ['domain', domainToolSpecs(deps)],
  ['aggregate', aggregateToolSpecs(deps)],
  ['advisor', advisorToolSpecs(deps)],
  ['history', historyToolSpecs({ ...deps, store: {} } as never)],
  ['system', systemToolSpecs({ ...deps, budget: {}, minute: {}, cacheStats: undefined, tokenExpiresAt: () => undefined, fixtureMode: false } as never)],
];

const detail = process.argv.includes('--detail');
if (!detail) {
  process.stdout.write(`${JSON.stringify(families.flatMap(([, specs]) => toolNames(specs)))}\n`);
} else {
  process.stdout.write(
    `${JSON.stringify(
      families.flatMap(([family, specs]) => specs.map((s) => ({ name: s.name, title: s.title, family }))),
      null,
      2,
    )}\n`,
  );
}
