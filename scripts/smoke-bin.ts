/**
 * Launch the server the way an install does: through the bin symlink, from outside
 * the project directory.
 *
 * A global install and `npx` run `build/server.js` via `bin/polestar-mcp`, so argv[1]
 * is the link while the module's own URL is the resolved file. The startup guard used
 * to compare those two directly, so under the symlink the process started, ran
 * nothing, and exited 0 silently: every documented install path was dead. Fixture
 * mode keeps this offline, and it asserts --version, --help and a real handshake.
 * Prints BIN_SMOKE_OK only after all three pass.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'build', 'server.js');
if (!existsSync(SERVER)) {
  console.error('BIN_SMOKE_FAILED: build/server.js is missing (run npm run build first)');
  process.exit(1);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'polestar-bin-'));
const bin = path.join(scratch, 'polestar-mcp');
symlinkSync(SERVER, bin);
chmodSync(SERVER, 0o755);

const failures: string[] = [];

function run(args: string[], stdin = ''): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, POLESTAR_FIXTURES_DIR: path.join(ROOT, 'test', 'fixtures', 'dump') } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    if (stdin.length > 0) child.stdin.write(stdin);
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: -1, out, err }); }, 20_000);
    child.on('exit', () => { clearTimeout(timer); resolve({ code: 0, out, err }); });
  });
}

const version = await run(['--version']);
if (!/\d+\.\d+\.\d+/.test(version.out)) failures.push(`--version printed nothing through the symlink: ${JSON.stringify(version.out.slice(0, 80))}`);

const help = await run(['--help']);
if (!/POLESTAR_CLIENT_ID/.test(help.out)) failures.push('--help produced no usage text');

const handshake = await run([], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bin-smoke', version: '0' } } }) + '\n');
if (!/"serverInfo"/.test(handshake.out)) failures.push(`no initialize response through the symlink: ${JSON.stringify(handshake.out.slice(0, 120))}`);

rmSync(scratch, { recursive: true, force: true });
if (failures.length > 0) {
  console.error('BIN_SMOKE_FAILED:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('BIN_SMOKE_OK --version, --help and the MCP handshake all work launched through the bin symlink');
