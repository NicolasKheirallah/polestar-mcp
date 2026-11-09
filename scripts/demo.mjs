#!/usr/bin/env node
/**
 * Offline demo that works from a checkout and from the packed npm package.
 *
 * Spawns build/server.js against the shipped synthetic dump
 * (test/fixtures/dump), asserts real values through the MCP stdio surface, and
 * prints DUMP_OK. Plain Node, so the packed package needs no tsx and no
 * development dependency.
 *
 *   npm run demo
 *   POLESTAR_FIXTURES_DIR=/path/to/captured/dump npm run demo
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SERVER = path.join(ROOT, 'build', 'server.js');
const DEFAULT_FIXTURES = path.join(ROOT, 'test', 'fixtures', 'dump');
const FIXTURES = process.env.POLESTAR_FIXTURES_DIR?.trim()
  ? path.resolve(process.env.POLESTAR_FIXTURES_DIR)
  : DEFAULT_FIXTURES;

function fail(message) {
  console.error(`DUMP_FAILED: ${message}`);
  process.exit(1);
}

if (!existsSync(SERVER)) fail(`build/server.js is missing at ${SERVER}; run npm run build first`);
if (!existsSync(path.join(FIXTURES, 'dataportal', 'vehicles.json'))) {
  fail(`expected captured dump at ${FIXTURES} (dataportal/vehicles.json not found)`);
}

/** Minimal newline-delimited JSON-RPC client over a child stdio transport. */
class DemoClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.nextId = 1;
    this.stderrText = '';
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (typeof message.id === 'number' && typeof message.method === 'string') {
        // The demo runs against one synthetic vehicle, so no elicitation is
        // expected. Answer defensively rather than leaving a request hanging.
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n');
        return;
      }
      if (typeof message.id === 'number') {
        const resolve = this.pending.get(message.id);
        if (resolve !== undefined) {
          this.pending.delete(message.id);
          resolve(message);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      this.stderrText += chunk.toString();
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n',
      );
    });
  }

  async initialize() {
    const init = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'polestar-mcp-demo', version: '0.0.0' },
    });
    const name = init.result?.serverInfo?.name;
    if (name !== 'polestar-mcp') throw new Error(`handshake failed: server name ${JSON.stringify(name)}`);
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async callTool(name, args = {}) {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error !== undefined) {
      return { text: '', isError: true, protocolError: response.error };
    }
    const content = response.result?.content;
    const text = Array.isArray(content) ? content.map((block) => block.text ?? '').join('\n') : '';
    return { text, isError: response.result?.isError === true };
  }

  stop() {
    this.child.kill('SIGTERM');
  }

  kill() {
    this.child.kill('SIGKILL');
  }
}

const child = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env: { ...process.env, POLESTAR_FIXTURES_DIR: FIXTURES },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const client = new DemoClient(child);

try {
  await client.initialize();

  // Outputs are humanized. The VIN arrives in the summary line and the raw
  // payload rides along when raw=true, exactly as the packed server renders it.
  const vehicles = await client.callTool('list_vehicles');
  const vinMatch = /([A-HJ-NPR-Z0-9]{17})/.exec(vehicles.text);
  if (vinMatch === null) throw new Error('dump did not yield a plausible VIN list');
  const vin = vinMatch[1];

  const battery = await client.callTool('get_battery', { vin, raw: true });
  if (!battery.text.includes('Charge:') || !/\d+/.test(battery.text)) {
    throw new Error('dump battery response did not humanize');
  }
  const rawJson = battery.text.slice(battery.text.indexOf('{'));
  const batteryData = JSON.parse(rawJson);
  if (typeof batteryData.batteryChargeLevelPercentage !== 'number') {
    throw new Error('dump battery raw payload did not include batteryChargeLevelPercentage');
  }

  const unavailable = await client.callTool('get_is_at_charge_location', { vin });
  if (unavailable.isError || unavailable.protocolError || !unavailable.text.includes('DATA_NOT_AVAILABLE')) {
    throw new Error(`dump is-at-charge-location was not surfaced as DATA_NOT_AVAILABLE: ${unavailable.text}`);
  }

  client.stop();
  console.log('DUMP_OK');
  process.exit(0);
} catch (err) {
  client.kill();
  console.error('DUMP_FAILED:', err instanceof Error ? err.message : err);
  console.error('--- server stderr ---');
  console.error(client.stderrText);
  process.exit(1);
}
