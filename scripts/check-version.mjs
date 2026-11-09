#!/usr/bin/env node
/**
 * Single-source version gate.
 *
 * The version appears in package.json, server.json (top level and the npm
 * package entry), the README badge, the newest released CHANGELOG heading and
 * the matching docs/releases/vX.Y.Z.md file. This check fails when any of them
 * disagrees, so a release cannot ship with two versions of the truth.
 *
 * Prints VERSION_OK <version> on success.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

const problems = [];
const pkg = readJson('package.json');
const version = pkg.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  problems.push(`package.json version is not a plain semver: ${JSON.stringify(version)}`);
}

const server = readJson('server.json');
if (server.version !== version) problems.push(`server.json version is ${server.version}, package.json is ${version}`);
const npmPackage = Array.isArray(server.packages)
  ? server.packages.find((entry) => entry.registryType === 'npm')
  : undefined;
if (npmPackage === undefined) problems.push('server.json has no npm package entry');
else if (npmPackage.version !== version) problems.push(`server.json npm package version is ${npmPackage.version}, package.json is ${version}`);
if (pkg.mcpName !== server.name) {
  problems.push(`package.json mcpName ${JSON.stringify(pkg.mcpName)} does not match server.json name ${JSON.stringify(server.name)}`);
}

const readme = read('README.md');
const badge = /badge\/version-(\d+\.\d+\.\d+)/.exec(readme);
if (badge === null) problems.push('README.md has no version badge of the form badge/version-X.Y.Z');
else if (badge[1] !== version) problems.push(`README.md badge says ${badge[1]}, package.json is ${version}`);

const changelog = read('CHANGELOG.md');
const released = /^## (\d+\.\d+\.\d+)\s*$/m.exec(changelog);
if (released === null) problems.push('CHANGELOG.md has no released version heading of the form ## X.Y.Z');
else if (released[1] !== version) problems.push(`CHANGELOG.md newest released heading is ${released[1]}, package.json is ${version}`);

const releaseNote = `docs/releases/v${version}.md`;
if (!existsSync(path.join(ROOT, releaseNote))) {
  problems.push(`missing release note ${releaseNote}`);
} else if (!read(releaseNote).includes(version)) {
  problems.push(`${releaseNote} does not mention ${version}`);
}

if (problems.length > 0) {
  console.error('VERSION_CHECK_FAILED:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`VERSION_OK ${version}`);
