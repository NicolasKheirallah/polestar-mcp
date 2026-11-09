import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The documentation and version gates are part of the product's claims, so they
 * get the same treatment as the runtime checks: a positive control that proves
 * the gate can fail, then a clean copy that proves it still passes. Every probe
 * runs against a throwaway tree; the checkout is read, never written.
 */

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runScript(script: string, args: readonly string[], cwd: string): RunResult {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'polestar-gates-'));
}

function write(root: string, rel: string, body: string): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function copyGate(root: string, rel: string): string {
  const dest = path.join(root, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(path.join(ROOT, rel), dest);
  return dest;
}

/**
 * The links gate falls back to a fixed document set when the tree is not a git
 * checkout, and that set has a five file scope floor. Create all five so the
 * probe exercises the link check instead of the scope guard.
 */
function markdownTree(root: string, readme: string, contributing: string): void {
  write(root, 'README.md', readme);
  write(root, 'CONTRIBUTING.md', contributing);
  write(root, 'SECURITY.md', '# Security\n');
  write(root, 'CHANGELOG.md', '# Changelog\n\n## 1.0.0\n');
  write(root, 'AGENTS.md', '# Agents\n');
}

function versionTree(root: string, options: { readonly serverVersion?: string; readonly mcpName?: string } = {}): void {
  const version = '1.2.3';
  write(
    root,
    'package.json',
    JSON.stringify({ name: 'probe-package', version, mcpName: options.mcpName ?? 'io.github.probe/server' }, null, 2) + '\n',
  );
  write(
    root,
    'server.json',
    JSON.stringify(
      {
        $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
        name: 'io.github.probe/server',
        description: 'probe',
        version: options.serverVersion ?? version,
        packages: [{ registryType: 'npm', identifier: 'probe-package', version, transport: { type: 'stdio' } }],
      },
      null,
      2,
    ) + '\n',
  );
  write(root, 'README.md', `# probe\n\n![version](https://img.shields.io/badge/version-${version}-blue)\n`);
  write(root, 'CHANGELOG.md', `# Changelog\n\n## Unreleased\n\n- probe\n\n## ${version}\n\n- probe\n`);
  write(root, `docs/releases/v${version}.md`, `# probe v${version}\n\nThe probe release.\n`);
}

test('links gate fails on a broken link outside docs and passes a clean tree', () => {
  const dir = scratch();
  const gate = copyGate(dir, 'docs/check-docs.mjs');
  markdownTree(dir, '# readme\n', '# contributing\n');
  try {
    const clean = runScript(gate, ['links'], dir);
    assert.equal(clean.code, 0, clean.stderr);
    assert.match(clean.stdout, /DOCS_LINKS_OK/);

    // A broken link in CONTRIBUTING.md used to be invisible: the gate only read
    // docs/*.md plus README. This is the positive control for the wider scope.
    write(dir, 'CONTRIBUTING.md', '# contributing\n\nSee [missing](no-such-doc.md).\n');
    const broken = runScript(gate, ['links'], dir);
    assert.equal(broken.code, 1, 'the gate must fail on a broken CONTRIBUTING link');
    assert.match(broken.stderr, /LINKS_CHECK_FAILED/);
    assert.match(broken.stderr, /CONTRIBUTING\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('envvars gate reads full names with digits from every src file and needs the docs', () => {
  const dir = scratch();
  const gate = copyGate(dir, 'docs/check-docs.mjs');
  // A digit inside the name is the case the old [A-Z_]+ regex truncated to
  // POLESTAR_M, which could never fail. The second file proves the walk covers
  // more than src/config.ts and src/server.ts.
  const known = 'POLESTAR_REDACT_VIN';
  const digit = 'POLESTAR_TIMEOUT_2_MS';
  write(dir, 'src/config.ts', `export const timeout = process.env.${known};\nexport const probe = process.env.${digit};\n`);
  write(dir, 'src/extra.ts', 'export const other = process.env.POLESTAR_EXTRA_FILE_ONLY;\n');
  write(dir, 'README.md', `# probe\n\n${known}\n`);
  write(dir, 'docs/getting-started.md', `# start\n\n${known}\n`);
  write(dir, '.env.example', `# probe\n${known}=\n`);
  try {
    const missing = runScript(gate, ['envvars'], dir);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /ENVVARS_CHECK_FAILED/);
    assert.match(missing.stderr, new RegExp(digit), 'the failure names the full variable, not POLESTAR_TIMEOUT_');
    assert.match(missing.stderr, /POLESTAR_EXTRA_FILE_ONLY/);
    assert.match(missing.stderr, /\.env\.example/, 'every document is named, including the template');

    write(dir, 'README.md', `# probe\n\n${known}\n${digit}\nPOLESTAR_EXTRA_FILE_ONLY\n`);
    write(dir, 'docs/getting-started.md', `# start\n\n${known}\n${digit}\nPOLESTAR_EXTRA_FILE_ONLY\n`);
    write(dir, '.env.example', `# probe\n${known}=\n${digit}=\nPOLESTAR_EXTRA_FILE_ONLY=\n`);
    const clean = runScript(gate, ['envvars'], dir);
    assert.equal(clean.code, 0, clean.stderr);
    assert.match(clean.stdout, /DOCS_ENVVARS_OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('version gate fails on a server.json version mismatch and passes aligned files', () => {
  const dir = scratch();
  const gate = copyGate(dir, 'scripts/check-version.mjs');
  try {
    versionTree(dir, { serverVersion: '9.9.9' });
    const broken = runScript(gate, [], dir);
    assert.equal(broken.code, 1);
    assert.match(broken.stderr, /VERSION_CHECK_FAILED/);
    assert.match(broken.stderr, /server\.json version is 9\.9\.9/);

    versionTree(dir);
    const clean = runScript(gate, [], dir);
    assert.equal(clean.code, 0, clean.stderr);
    assert.match(clean.stdout, /VERSION_OK 1\.2\.3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('version gate catches a README badge that disagrees', () => {
  const dir = scratch();
  const gate = copyGate(dir, 'scripts/check-version.mjs');
  try {
    versionTree(dir);
    write(dir, 'README.md', '# probe\n\n![version](https://img.shields.io/badge/version-0.0.1-blue)\n');
    const broken = runScript(gate, [], dir);
    assert.equal(broken.code, 1);
    assert.match(broken.stderr, /README\.md badge says 0\.0\.1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server.json gate rejects the legacy name key and the legacy required key', () => {
  const dir = scratch();
  const gate = copyGate(dir, 'scripts/validate-server-json.mjs');
  const valid = (): void => {
    write(dir, 'package.json', JSON.stringify({ name: 'probe-package', version: '1.2.3', mcpName: 'io.github.probe/server' }, null, 2) + '\n');
    write(
      dir,
      'server.json',
      JSON.stringify(
        {
          $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
          name: 'io.github.probe/server',
          description: 'probe',
          version: '1.2.3',
          repository: { url: 'https://github.com/probe/server', source: 'github' },
          packages: [
            {
              registryType: 'npm',
              identifier: 'probe-package',
              version: '1.2.3',
              transport: { type: 'stdio' },
              environmentVariables: [{ name: 'PROBE_TOKEN', isRequired: true, isSecret: true }],
            },
          ],
        },
        null,
        2,
      ) + '\n',
    );
  };
  try {
    valid();
    const clean = runScript(gate, [], dir);
    assert.equal(clean.code, 0, clean.stderr);
    assert.match(clean.stdout, /SERVER_JSON_OK/);

    // The pre-wave shape: package name instead of identifier.
    const doc = JSON.parse(readFileSync(path.join(dir, 'server.json'), 'utf8')) as {
      packages: Array<Record<string, unknown>>;
    };
    doc.packages[0]!.name = doc.packages[0]!.identifier;
    delete doc.packages[0]!.identifier;
    write(dir, 'server.json', JSON.stringify(doc, null, 2) + '\n');
    const missingIdentifier = runScript(gate, [], dir);
    assert.equal(missingIdentifier.code, 1);
    assert.match(missingIdentifier.stderr, /identifier is required/);

    // The pre-wave environment variable key.
    valid();
    const withLegacyEnv = JSON.parse(readFileSync(path.join(dir, 'server.json'), 'utf8')) as {
      packages: Array<{ environmentVariables: Array<Record<string, unknown>> }>;
    };
    withLegacyEnv.packages[0]!.environmentVariables[0]!.required = true;
    write(dir, 'server.json', JSON.stringify(withLegacyEnv, null, 2) + '\n');
    const legacyKey = runScript(gate, [], dir);
    assert.equal(legacyKey.code, 1);
    assert.match(legacyKey.stderr, /legacy required key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the package ships the docs, the demo and the bundle metadata, and the README links them', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { files: string[] };
  for (const entry of ['docs', 'mcpb', 'scripts/demo.mjs', 'test/fixtures/dump']) {
    assert.ok(pkg.files.includes(entry), `package.json files is missing ${entry}`);
  }
  for (const rel of ['docs/privacy.md', 'docs/reviewer-pack.md', 'docs/bundle.md', 'mcpb/manifest.json']) {
    assert.ok(existsSync(path.join(ROOT, rel)), `missing ${rel}`);
  }
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const link of ['docs/privacy.md', 'docs/reviewer-pack.md', 'docs/bundle.md']) {
    assert.ok(readme.includes(link), `README does not link ${link}`);
  }
});

test('the bundle manifest names the package version and maps the sensitive credential', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'mcpb/manifest.json'), 'utf8')) as {
    manifest_version: string;
    version: string;
    server: { type: string; entry_point: string; mcp_config?: { env?: Record<string, string> } };
    user_config: Record<string, { sensitive?: boolean; required?: boolean }>;
    privacy_policies: string[];
  };
  assert.equal(manifest.manifest_version, '0.3');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.server.type, 'node');
  assert.ok(manifest.server.entry_point.endsWith('build/server.js'));
  assert.equal(manifest.server.mcp_config?.env?.POLESTAR_CLIENT_SECRET, '${user_config.client_secret}');
  assert.equal(manifest.user_config.client_secret?.sensitive, true);
  assert.equal(manifest.user_config.client_secret?.required, true);
  assert.ok(Array.isArray(manifest.privacy_policies) && manifest.privacy_policies.length > 0);
  for (const url of manifest.privacy_policies) assert.match(url, /^https:\/\//);
});

test('every variable the server reads is present in the env template', async () => {
  const { KNOWN_ENV_VARIABLES } = await import('../src/config.js');
  const template = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const missing = KNOWN_ENV_VARIABLES.filter((name) => !template.includes(name));
  assert.deepEqual(missing, [], `missing from .env.example: ${missing.join(', ')}`);
});

test('the bin smoke reports its own result quickly', { skip: !existsSync(path.join(ROOT, 'build/server.js')) ? 'build/server.js is absent; run npm run build' : false }, () => {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/smoke-bin.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const elapsedMs = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BIN_SMOKE_OK/);
  assert.ok(elapsedMs < 10_000, `smoke-bin took ${elapsedMs}ms; it must close stdin and assert real exit codes`);
});

test('the checkout passes its own version and registry metadata gates', () => {
  const version = runScript(path.join(ROOT, 'scripts/check-version.mjs'), [], ROOT);
  assert.equal(version.code, 0, version.stderr);
  assert.match(version.stdout, /VERSION_OK \d+\.\d+\.\d+/);

  const serverJson = runScript(path.join(ROOT, 'scripts/validate-server-json.mjs'), [], ROOT);
  assert.equal(serverJson.code, 0, serverJson.stderr);
  assert.match(serverJson.stdout, /SERVER_JSON_OK/);
});
