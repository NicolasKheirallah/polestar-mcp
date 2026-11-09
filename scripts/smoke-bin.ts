/**
 * Launch the server the way an install does: through the bin symlink, from outside
 * the project directory.
 *
 * A global install and `npx` run `build/server.js` via `bin/polestar-mcp`, so argv[1]
 * is the link while the module's own URL is the resolved file. The startup guard used
 * to compare those two directly, so under the symlink the process started, ran
 * nothing, and exited 0 silently: every documented install path was dead. Fixture
 * mode keeps this offline.
 *
 * The harness is deliberately honest about what it observes:
 * - stdin is closed, so a successful handshake lets the server exit instead of
 *   waiting for a 20 second kill;
 * - every exit code is asserted, and the runner proves it can see a nonzero one
 *   with a positive control before the clean result counts;
 * - the executable bit is checked rather than set here, because a test that chmods
 *   the artifact it is checking cannot fail on a missing mode.
 *
 * Prints BIN_SMOKE_OK only after every assertion passes; the whole run should take
 * about a second.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'build', 'server.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'dump');
const COMMAND_TIMEOUT_MS = 10_000;

if (!existsSync(SERVER)) {
  console.error('BIN_SMOKE_FAILED: build/server.js is missing (run npm run build first)');
  process.exit(1);
}
const mode = statSync(SERVER).mode & 0o777;
if ((mode & 0o111) === 0) {
  console.error(`BIN_SMOKE_FAILED: build/server.js is not executable (mode ${mode.toString(8)}); run npm run build`);
  process.exit(1);
}
const expectedVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const scratch = mkdtempSync(path.join(tmpdir(), 'polestar-bin-'));
const bin = path.join(scratch, 'polestar-mcp');
symlinkSync(SERVER, bin);

interface RunResult {
  code: number;
  signal: string | null;
  out: string;
  err: string;
  timedOut: boolean;
}

function spawnCollect(command: string, args: string[], stdin: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, POLESTAR_FIXTURES_DIR: FIXTURES },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    if (stdin.length > 0) child.stdin.write(stdin);
    // Closing stdin is what lets a stdio server finish a request and exit. Leaving
    // it open made the old harness wait for its kill timer on every run.
    child.stdin.end();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, COMMAND_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, signal, out, err, timedOut });
    });
  });
}

const runBin = (args: string[], stdin = ''): Promise<RunResult> => spawnCollect(bin, args, stdin);

const failures: string[] = [];
const check = (label: string, ok: boolean, detail: string): void => {
  if (!ok) failures.push(`${label}: ${detail}`);
};

// Positive control: the runner must observe a real nonzero exit code, otherwise a
// clean result below would mean the harness is asleep.
const control = await spawnCollect(process.execPath, ['-e', 'process.exit(3)'], '');
check('positive control', control.code === 3 && !control.timedOut, `expected exit 3 from a known bad child, saw ${control.code}`);

const version = await runBin(['--version']);
check('--version exit', version.code === 0 && !version.timedOut, `exit ${version.code}, timedOut=${version.timedOut}, stderr=${JSON.stringify(version.err.slice(0, 120))}`);
check('--version output', version.out.trim() === expectedVersion, `printed ${JSON.stringify(version.out.trim())}, package.json says ${expectedVersion}`);

const help = await runBin(['--help']);
check('--help exit', help.code === 0 && !help.timedOut, `exit ${help.code}, timedOut=${help.timedOut}`);
check('--help output', /POLESTAR_CLIENT_ID/.test(help.out), 'no usage text');

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bin-smoke', version: '0' } },
}) + '\n';
const handshake = await runBin([], initialize);
check('handshake exit', handshake.code === 0 && !handshake.timedOut, `exit ${handshake.code}, timedOut=${handshake.timedOut}, stderr=${JSON.stringify(handshake.err.slice(0, 120))}`);
check('handshake output', /"serverInfo"/.test(handshake.out), `no initialize response: ${JSON.stringify(handshake.out.slice(0, 120))}`);

rmSync(scratch, { recursive: true, force: true });
if (failures.length > 0) {
  console.error('BIN_SMOKE_FAILED:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`BIN_SMOKE_OK version ${expectedVersion}, --help, and the MCP handshake all exit cleanly through the bin symlink`);
