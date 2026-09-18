/**
 * Every domain must have a fixture, and every fixture must be a valid envelope.
 * A missing fixture previously read as "this vehicle reports nothing", which is
 * the one confusion the fixture mode must never allow.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
import { DOMAINS } from '../src/domains.js';
const problems = [];
if (!existsSync(path.join(ROOT, 'test/fixtures/dump/token.json'))) problems.push('token.json missing');
if (!existsSync(path.join(ROOT, 'test/fixtures/dump/dataportal/vehicles.json'))) problems.push('vehicles.json missing');
for (const { kind, name } of DOMAINS) {
  const file = path.join(ROOT, 'test/fixtures/dump', 'dataportal', kind, `${name}.json`);
  if (!existsSync(file)) { problems.push(`${kind}/${name}: no fixture`); continue; }
  let body;
  try { body = JSON.parse(readFileSync(file, 'utf8')); } catch { problems.push(`${kind}/${name}: not valid JSON`); continue; }
  const isError = body?.error?.code !== undefined;
  if (!isError && body?.data === undefined) problems.push(`${kind}/${name}: neither data nor error envelope`);
  if (!isError && body?.meta?.domain !== name) problems.push(`${kind}/${name}: meta.domain is ${JSON.stringify(body?.meta?.domain)}`);
  if (!isError && typeof body.meta?.vin !== 'string') problems.push(`${kind}/${name}: meta.vin missing`);
}
if (problems.length > 0) { console.error('FIXTURES_BAD:'); for (const p of problems) console.error('  ' + p); process.exit(1); }
console.log('FIXTURES_OK');
