// Self-test: runs main.ts on test/levels/*.txt and replays every solution
// with an independent replayer (written here, not shared with main.ts).
// Usage: node test/check.mjs   (exits 1 on any failure)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'sokoban-test-'));
const input = join(tmp, 'input');
const output = join(tmp, 'output');
const levels = readdirSync(join(root, 'test', 'levels')).sort();
for (const [k, name] of levels.entries()) {
  const id = 't' + String(k + 1).padStart(3, '0');
  mkdirSync(join(input, id), { recursive: true });
  writeFileSync(join(input, id, 'level.txt'), readFileSync(join(root, 'test', 'levels', name)));
}
execFileSync('node', [join(root, 'main.ts')], {
  env: { ...process.env, MAKEFUN_INPUT_DIR: input, MAKEFUN_OUTPUT_DIR: output },
  stdio: 'inherit',
});

const STEP = { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] };
let failed = 0;
for (const [k, name] of levels.entries()) {
  const id = 't' + String(k + 1).padStart(3, '0');
  const text = readFileSync(join(input, id, 'level.txt'), 'utf8');
  const moves = readFileSync(join(output, id, 'solution.txt'), 'utf8').replace(/\s+/g, '');
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Set();
  const goal = new Set();
  const box = new Set();
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const i = y * w + x;
      const ch = row[x];
      if (ch === '#') wall.add(i);
      if ('.*+'.includes(ch)) goal.add(i);
      if ('$*'.includes(ch)) box.add(i);
      if ('@+'.includes(ch)) player = i;
    }
  });
  let pushes = 0;
  let ok = true;
  for (const ch of moves) {
    const [dx, dy] = STEP[ch];
    const next = player + dy * w + dx;
    if (wall.has(next)) { ok = false; break; }
    if (box.has(next)) {
      const beyond = next + dy * w + dx;
      if (wall.has(beyond) || box.has(beyond)) { ok = false; break; }
      box.delete(next);
      box.add(beyond);
      pushes++;
    }
    player = next;
  }
  if (ok) for (const b of box) if (!goal.has(b)) ok = false;
  console.log(`${name}: ${ok ? 'SOLVED' : 'FAILED'} in ${pushes} pushes (${moves.length} moves)`);
  if (!ok) failed++;
}
if (failed > 0) {
  console.error(`${failed} level(s) failed`);
  process.exit(1);
}
console.log('all test levels solved');
