/**
 * Probe: list_vehicles declares no delegated_account_id argument, so a delegating
 * caller's argument is dropped by the SDK and the tool answers from the operator's
 * own identity. Every other tool that reads identity-scoped data takes it.
 *
 * Also show the cache interaction: the answer is the same cached URL the owner
 * primed (probe-cache-delegation.ts covers that side).
 */
import { domainToolSpecs } from '../../src/domain-tools.js';
import { toolSpec } from '../../src/tools.js';
import type { PolestarClient } from '../../src/client.js';
import type { ToolDeps } from '../../src/tool-output.js';

const calls: string[] = [];
const owner = {
  async vehicles() {
    calls.push('owner.vehicles');
    return ['YSMTEST22PL000001'];
  },
  async resolveVin(v?: string) {
    return v ?? 'YSMTEST22PL000001';
  },
  async domain() {
    return {};
  },
  forDelegation(id: string) {
    calls.push(`forDelegation:${id}`);
    return {
      async vehicles() {
        calls.push('delegated.vehicles');
        return ['YSM-PARTNER-VIN-01'];
      },
      async resolveVin(v?: string) {
        return v ?? 'YSM-PARTNER-VIN-01';
      },
      async domain() {
        return {};
      },
    };
  },
} as unknown as PolestarClient;

const deps: ToolDeps = {
  client: owner,
  redactVin: false,
  vehicleLabels: {},
  delegatedAccounts: ['partner-a'],
  units: 'km',
};

const list = toolSpec(domainToolSpecs(deps), 'list_vehicles');
const declaredArgs = Object.keys(list.args ?? {});
const result = await list.run({ delegated_account_id: 'partner-a' }, {});

console.log(
  JSON.stringify(
    {
      list_vehicles_declared_args: declaredArgs,
      caller_passed: { delegated_account_id: 'partner-a' },
      client_calls: calls,
      resultText: result.content[0]!.text,
    },
    null,
    2,
  ),
);
