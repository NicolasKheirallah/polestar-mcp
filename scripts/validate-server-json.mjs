#!/usr/bin/env node
/**
 * Validate server.json against the shape the MCP Registry currently requires,
 * without a network call, so CI can fail on metadata drift even when the
 * registry or its schema host is unreachable.
 *
 * Shape facts encoded here, all from the published 2025-12-11 schema:
 * packages[].registryType, packages[].identifier and packages[].transport are
 * required; environment variables use isRequired and isSecret, not the legacy
 * required key; the package.json mcpName must equal server.json name.
 *
 * Prints SERVER_JSON_OK <name>@<version> packages=<n>.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CURRENT_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const REGISTRY_TYPES = new Set(['npm', 'pypi', 'oci', 'nuget', 'mcpb']);
const TRANSPORT_TYPES = new Set(['stdio', 'sse', 'streamable-http']);

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const server = JSON.parse(readFileSync(path.join(ROOT, 'server.json'), 'utf8'));
const problems = [];

if (server.$schema !== CURRENT_SCHEMA) {
  problems.push(`$schema must be ${CURRENT_SCHEMA}, saw ${JSON.stringify(server.$schema)}`);
}
if (typeof server.name !== 'string' || !/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(server.name)) {
  problems.push('name must be in reverse-DNS form with exactly one slash, for example io.github.owner/server');
}
if (pkg.mcpName !== server.name) {
  problems.push(`package.json mcpName ${JSON.stringify(pkg.mcpName)} must equal server.json name ${JSON.stringify(server.name)}`);
}
if (typeof server.description !== 'string' || server.description.length === 0 || server.description.length > 100) {
  problems.push('description must be a non-empty string of at most 100 characters');
}
if (server.version !== pkg.version) {
  problems.push(`server.json version ${JSON.stringify(server.version)} must equal package.json version ${JSON.stringify(pkg.version)}`);
}
if (typeof server.repository?.url !== 'string' || typeof server.repository?.source !== 'string') {
  problems.push('repository.url and repository.source are required');
}

if (!Array.isArray(server.packages) || server.packages.length === 0) {
  problems.push('packages must be a non-empty array');
} else {
  for (const [index, entry] of server.packages.entries()) {
    const where = `packages[${index}]`;
    if (!REGISTRY_TYPES.has(entry.registryType)) {
      problems.push(`${where}.registryType must be one of ${[...REGISTRY_TYPES].join(', ')}, saw ${JSON.stringify(entry.registryType)}`);
    }
    if (typeof entry.identifier !== 'string' || entry.identifier.length === 0) {
      problems.push(`${where}.identifier is required (a name is not an identifier)`);
    }
    if (entry.transport?.type === undefined || !TRANSPORT_TYPES.has(entry.transport.type)) {
      problems.push(`${where}.transport.type must be one of ${[...TRANSPORT_TYPES].join(', ')}`);
    }
    if (entry.registryType === 'npm') {
      if (entry.identifier !== pkg.name) problems.push(`${where}.identifier ${JSON.stringify(entry.identifier)} must equal npm package name ${JSON.stringify(pkg.name)}`);
      if (entry.version !== pkg.version) problems.push(`${where}.version must equal package.json version`);
    }
    for (const [envIndex, env] of (entry.environmentVariables ?? []).entries()) {
      const envWhere = `${where}.environmentVariables[${envIndex}]`;
      if (typeof env.name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(env.name)) {
        problems.push(`${envWhere}.name must be an environment variable name, saw ${JSON.stringify(env.name)}`);
      }
      if ('required' in env) problems.push(`${envWhere} uses the legacy required key; the current schema uses isRequired`);
      if (env.isRequired !== undefined && typeof env.isRequired !== 'boolean') problems.push(`${envWhere}.isRequired must be a boolean`);
      if (env.isSecret !== undefined && typeof env.isSecret !== 'boolean') problems.push(`${envWhere}.isSecret must be a boolean`);
    }
  }
}

if (problems.length > 0) {
  console.error('SERVER_JSON_FAILED:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`SERVER_JSON_OK ${server.name}@${server.version} packages=${server.packages.length}`);
