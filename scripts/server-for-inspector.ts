/** Launch the server under @modelcontextprotocol/inspector: `npm run inspect`. */
import { spawn } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const child = spawn('npx', ['@modelcontextprotocol/inspector', '--transport', 'stdio', 'node', '--import', 'tsx', 'src/server.ts'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, POLESTAR_FIXTURES_DIR: process.env.POLESTAR_FIXTURES_DIR ?? path.join(root, 'test/fixtures/dump') },
});
child.on('exit', (code) => process.exit(code ?? 1));
