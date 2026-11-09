/**
 * Probe: does the redaction rule reach the identity-mismatch error text?
 *
 * VIN_MISMATCH is the one error whose message names vehicles by VIN. It is
 * rendered through the shared errorResult path, which has no redaction.
 */
import { errorResult } from '../../../build/tool-output.js';
import { PolestarApiError } from '../../../build/client.js';

const wanted = 'YSMTEST22PL000001';
const actual = 'YSMTEST22PL000002';

const mismatch = new PolestarApiError(
  'VIN_MISMATCH',
  `Requested ${wanted} but the telemetry/battery response is labelled ${actual}.`,
  200,
);
const rendered = errorResult(mismatch);
const text = JSON.stringify(rendered);
console.log('errorResult contains requested VIN:', text.includes(wanted));
console.log('errorResult contains other VIN    :', text.includes(actual));
console.log(rendered.content?.[0]?.text ?? text);
