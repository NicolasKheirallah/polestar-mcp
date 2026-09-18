#!/usr/bin/env node
/**
 * Fail when prose that a model or an operator acts on names a tool the registry
 * does not define.
 *
 * The registry is obtained by building the specs, not by pattern-matching their
 * source. The scan covers the instruction surface, descriptions, the MCP
 * `instructions` string, prompt bodies, argument descriptions, and the operator's
 * env template, and deliberately skips comments: a comment may *name* a past
 * mistake, which is exactly what the first run of this check caught about itself.
 *
 * Exit 0 prints TOOL_REFS_OK with the number of names checked.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const listed = JSON.parse(
  spawnSync('node', ['--import', 'tsx', 'scripts/list-tools.ts'], { cwd: ROOT, encoding: 'utf8' }).stdout,
);
const registered = new Set(listed);
if (registered.size === 0) {
  console.error('TOOL_REFS_FAILED: the registry answered with no names');
  process.exit(1);
}

const TOOL_SHAPED = /\b(?:get|list|is|plan|polestar)_[a-z][a-z_]*\b/g;

/** Strip line and block comments, keeping string contents intact. */
function withoutComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(text, i);
      out += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl - 1;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    out += c;
  }
  return out;
}

function skipString(text, start) {
  const quote = text[start];
  for (let j = start + 1; j < text.length; j++) {
    if (text[j] === '\\') { j += 1; continue; }
    if (quote === '`' && text[j] === '$' && text[j + 1] === '{') { j = skipBrace(text, j + 1); continue; }
    if (text[j] === quote) return j;
  }
  return text.length;
}

function skipBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (["'", '"', '`'].includes(c)) { i = skipString(text, i); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** Line numbers of tool-shaped names inside string literals that are unregistered. */
function scan(file) {
  const raw = readFileSync(path.join(ROOT, file), 'utf8');
  const stripped = withoutComments(raw);
  const findings = [];
  stripped.split('\n').forEach((line, idx) => {
    for (const m of line.matchAll(TOOL_SHAPED)) {
      if (registered.has(m[0])) continue;
      findings.push({ name: m[0], line: idx + 1 });
    }
  });
  return findings;
}

const sources = [
  ...readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.ts')).map((f) => `src/${f}`),
  '.env.example',
];

const findings = sources.flatMap((f) => scan(f).map((r) => ({ file: f, ...r })));
const checked = [...registered].length;

if (findings.length > 0) {
  console.error('TOOL_REFS_FAILED');
  for (const f of findings) console.error(`  "${f.name}" referenced at ${f.file}:${f.line} is not registered`);
  process.exit(1);
}
console.log(`TOOL_REFS_OK ${checked} registered names, ${sources.length} instruction-surface files scanned, 0 undefined names referenced`);
