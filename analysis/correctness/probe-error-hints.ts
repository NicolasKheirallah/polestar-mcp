/**
 * Probe: error-normalization / hint selection.
 *  A) readDomain() overrides every 403 with "this domain needs the OAuth scope X",
 *     but the repo's own live findings say a 403 is AUTHZ_VIN_UNAUTHORIZED or
 *     AUTHZ_CLIENT_ID_MISMATCH - neither is a scope problem (tool-output.ts says so).
 *     The aggregate tools (no override) give the right advice for the same error.
 *  B) a 401 answered with a non-JSON body becomes HTTP_401 and loses the UNAUTHORIZED
 *     hint, because UPSTREAM_HINTS is keyed by the API's code, not the status class.
 */
import { PolestarApiError } from '../../src/client.js';
import { readDomainFormatted } from '../../src/vehicle-read.js';
import { aggregateToolSpecs } from '../../src/aggregate-tools.js';
import { toolSpec } from '../../src/tools.js';
import type { PolestarClient } from '../../src/client.js';
import type { ToolDeps } from '../../src/tool-output.js';

const VIN = 'YSMTEST22PL000001';
const out: Record<string, unknown> = {};

function depsThatThrow(err: Error): ToolDeps {
  const client = {
    async resolveVin(v?: string) {
      return v ?? VIN;
    },
    async vehicles() {
      return [VIN];
    },
    async domain() {
      throw err;
    },
    forDelegation() {
      return this;
    },
  } as unknown as PolestarClient;
  return { client, redactVin: false, vehicleLabels: {}, delegatedAccounts: [], units: 'km' };
}

const battery = { kind: 'telemetry' as const, name: 'battery', scope: 'pdp-telemetry/battery' };

for (const code of ['AUTHZ_CLIENT_ID_MISMATCH', 'AUTHZ_VIN_UNAUTHORIZED']) {
  const err = new PolestarApiError(code, 'upstream says no', 403, 'req-1');
  const domainTool = await readDomainFormatted(depsThatThrow(err), battery, {}, {});
  const aggregateTool = await toolSpec(aggregateToolSpecs(depsThatThrow(err)), 'get_car_status').run({}, {});
  out[`403_${code}`] = {
    get_battery_hint: domainTool.structuredContent?.hint,
    get_car_status_hint: aggregateTool.structuredContent?.hint,
  };
}

// B) non-JSON 401 body -> HTTP_401
const client401 = {
  async resolveVin(v?: string) {
    return v ?? VIN;
  },
  async vehicles() {
    return [VIN];
  },
  async domain() {
    throw new PolestarApiError('HTTP_401', 'Request failed (HTTP 401): Unauthorized', 401);
  },
} as unknown as PolestarClient;
const plain401 = await readDomainFormatted(
  { client: client401, redactVin: false, vehicleLabels: {}, delegatedAccounts: [], units: 'km' },
  battery,
  {},
  {},
);
out.plain_401 = { code: plain401.structuredContent?.code, hint: plain401.structuredContent?.hint };

console.log(JSON.stringify(out, null, 2));
