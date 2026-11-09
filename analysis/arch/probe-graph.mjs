// Import graph over src/: cycles, fan-in, fan-out. Read-only probe used by the audit.
import { readFileSync, readdirSync } from 'node:fs';

const dir = 'src';
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
const graph = new Map();
for (const file of files) {
  const source = readFileSync(`${dir}/${file}`, 'utf8');
  const deps = [...source.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)]
    .map((m) => m[1])
    .map((d) => (d.endsWith('.js') ? `${d.slice(0, -3)}.ts` : d));
  graph.set(file, [...new Set(deps)]);
}

const state = new Map();
const cycles = [];
function dfs(node, path) {
  if (state.get(node) === 'visiting') {
    cycles.push([...path.slice(path.indexOf(node)), node].join(' -> '));
    return;
  }
  if (state.get(node) === 'done') return;
  state.set(node, 'visiting');
  path.push(node);
  for (const dep of graph.get(node) ?? []) dfs(dep, path);
  path.pop();
  state.set(node, 'done');
}
for (const file of files) dfs(file, []);

const fanOut = [...graph]
  .map(([f, d]) => ({ module: f, count: d.length }))
  .sort((a, b) => b.count - a.count);
const fanIn = new Map(files.map((f) => [f, 0]));
for (const deps of graph.values()) for (const dep of deps) if (fanIn.has(dep)) fanIn.set(dep, fanIn.get(dep) + 1);

console.log(`modules: ${files.length}`);
console.log(`cycles: ${cycles.length === 0 ? 'none' : [...new Set(cycles)].join(', ')}`);
console.log('fan-out: ' + fanOut.slice(0, 6).map((x) => `${x.module}:${x.count}`).join(', '));
console.log('fan-in: ' + [...fanIn].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([f, n]) => `${f}:${n}`).join(', '));
