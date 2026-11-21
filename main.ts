// sokoban-solver 1.0.0 — a push-optimal Sokoban solver, built for make.fun's
// "Build the best Sokoban solver, 21 November 2026" bounty.
//
// How it works:
//  * make.fun's levels are a one-square-wide hallway with one to four small
//    rooms off it (3-4 boxes each). A box pushed out of its room through the
//    door can never come back, so in any optimal solution every box stays in
//    its room and a level's push-optimal count is the sum of its rooms'.
//    This program therefore splits each level into its rooms, solves every
//    room on its own, and stitches the room solutions together with walks
//    along the hallway.
//  * Each room is solved with A* over pushes (not single steps): a state is
//    the sorted box squares plus the player's reachable region, a move is one
//    push, and the heuristic is the cheapest assignment of boxes to goals
//    under single-box push distances. Dead squares (from reverse-pull
//    reachability), 2x2 freeze blocks and the assignment bound prune the
//    search, so each room comes out push-optimal.
//  * The whole run is deterministic: searches are capped by expansions, not
//    by the clock, so two runs write the same bytes.
//
// Usage: node main.ts — reads $MAKEFUN_INPUT_DIR/<id>/level.txt (default
// /input) and writes $MAKEFUN_OUTPUT_DIR/<id>/solution.txt (default /output)
// for every instance id. No dependencies, Node 22+, pure standard library.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const START_MS = Date.now();
/** Safety valve only: the searches below are capped by expansions (which is
 *  what keeps the output deterministic); this just stops a pathological
 *  level from eating the whole 60-second budget. */
const WALL_CLOCK_LIMIT_MS = 50_000;
/** Per-room expansion caps: A* first, then a weighted (greedy-leaning) retry. */
const ASTAR_CAP = 200_000;
const GREEDY_CAP = 200_000;

/** up, down, left, right: [dx, dy, letter, opposite index]. */
const DIRS = [
  [0, -1, 'u', 1],
  [0, 1, 'd', 0],
  [-1, 0, 'l', 3],
  [1, 0, 'r', 2],
] as const;

interface Level {
  w: number;
  h: number;
  /** 1 = wall, 0 = floor, over w*h cells. */
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse an XSB level: # wall, ' ' floor, . goal, $ box, * box on goal, @ player. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** One room of a level: its floor cells (in global cell numbers), the single
 *  door cell where it meets the hallway, and the hallway cell just outside
 *  the door where the player enters. Local indices run over the room's cells
 *  plus the entry cell. */
interface Room {
  /** Global cell numbers of the room's floor cells, then the entry cell last. */
  cells: number[];
  /** Global cell -> local index, -1 when the cell is not part of this room. */
  local: Int32Array;
  goals: number[];
  boxes: number[];
  /** Local index of the entry (hallway) cell: where the player starts. */
  entry: number;
  /** Local index of the door cell. */
  door: number;
  /** Global cell number of the entry cell. */
  entryGlobal: number;
  /** Global cell number of the door cell. */
  doorGlobal: number;
}

/**
 * Split a level into its rooms. The hallway is the player's row; every other
 * floor component is one room, and it must touch the hallway through exactly
 * one door cell, hold boxes and exactly as many goals. Returns null when the
 * level does not have that shape, so the caller can fall back to solving the
 * whole level at once.
 */
function decompose(lv: Level): Room[] | null {
  const hy = Math.floor(lv.player / lv.w);
  const boxSet = new Set(lv.boxes);
  const goalSet = new Set(lv.goals);
  const seen = new Uint8Array(lv.w * lv.h);
  const rooms: Room[] = [];
  const neighbours = (c: number): number[] => {
    const out: number[] = [];
    const x = c % lv.w;
    const y = Math.floor(c / lv.w);
    if (x > 0) out.push(c - 1);
    if (x + 1 < lv.w) out.push(c + 1);
    if (y > 0) out.push(c - lv.w);
    if (y + 1 < lv.h) out.push(c + lv.w);
    return out;
  };
  for (let i = 0; i < lv.w * lv.h; i++) {
    if (lv.wall[i] || seen[i]) continue;
    if (Math.floor(i / lv.w) === hy) continue;
    // Flood-fill one connected component of non-hallway floor.
    const comp: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const c = stack.pop() as number;
      comp.push(c);
      for (const n of neighbours(c)) {
        if (lv.wall[n] || seen[n]) continue;
        if (Math.floor(n / lv.w) === hy) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    // The door: the component's one cell beside a hallway floor cell.
    const doors = comp.filter((c) =>
      neighbours(c).some((n) => Math.floor(n / lv.w) === hy && !lv.wall[n]),
    );
    if (doors.length !== 1) return null;
    const doorGlobal = doors[0];
    const entryGlobal = neighbours(doorGlobal).find(
      (n) => Math.floor(n / lv.w) === hy && !lv.wall[n],
    ) as number;
    const boxes = comp.filter((c) => boxSet.has(c));
    const goals = comp.filter((c) => goalSet.has(c));
    if (boxes.length === 0 || boxes.length !== goals.length) return null;
    if (boxSet.has(entryGlobal) || goalSet.has(entryGlobal)) return null;
    const cells = [...comp, entryGlobal];
    const local = new Int32Array(lv.w * lv.h).fill(-1);
    cells.forEach((c, k) => {
      local[c] = k;
    });
    rooms.push({
      cells,
      local,
      goals: goals.map((c) => local[c]),
      boxes: boxes.map((c) => local[c]).sort((a, b) => a - b),
      entry: local[entryGlobal],
      door: local[doorGlobal],
      entryGlobal,
      doorGlobal,
    });
  }
  // Every box and every goal must belong to exactly one room.
  const coveredBoxes = rooms.reduce((a, r) => a + r.boxes.length, 0);
  const coveredGoals = rooms.reduce((a, r) => a + r.goals.length, 0);
  if (coveredBoxes !== lv.boxes.length || coveredGoals !== lv.goals.length) return null;
  // Deterministic order: leftmost door first, then topmost.
  rooms.sort(
    (a, b) => a.doorGlobal % lv.w - (b.doorGlobal % lv.w) || a.doorGlobal - b.doorGlobal,
  );
  return rooms;
}

/**
 * A room's push-distance table: dist[from][goal] is the fewest pushes that
 * move one box alone from `from` to that goal, ignoring the other boxes and
 * whether the player can actually reach the pushing squares. A box can be
 * pushed from x to x+d only when the square behind it (x-d, where the player
 * stands) and the square ahead (x+d) are both floor. Because both relaxations
 * only ever shorten the distance, the table is a lower bound on the real
 * push count — exactly what an admissible heuristic needs.
 */
function pushDistances(room: Room, lv: Level): number[][] {
  const n = room.cells.length;
  const nbr: number[][] = room.cells.map((c) => {
    const out: number[] = [];
    for (let d = 0; d < 4; d++) {
      const [dx, dy] = DIRS[d];
      const x = (c % lv.w) + dx;
      const y = Math.floor(c / lv.w) + dy;
      if (x < 0 || x >= lv.w || y < 0 || y >= lv.h) {
        out.push(-1);
      } else {
        out.push(room.local[y * lv.w + x]);
      }
    }
    return out;
  });
  const dist: number[][] = [];
  for (let s = 0; s < n; s++) {
    const d = new Array<number>(n).fill(Infinity);
    d[s] = 0;
    const queue = [s];
    for (let q = 0; q < queue.length; q++) {
      const x = queue[q];
      for (let dir = 0; dir < 4; dir++) {
        const behind = nbr[x][DIRS[dir][3]];
        const ahead = nbr[x][dir];
        if (behind < 0 || ahead < 0) continue;
        if (d[ahead] === Infinity) {
          d[ahead] = d[x] + 1;
          queue.push(ahead);
        }
      }
    }
    dist.push(d);
  }
  return dist;
}

/** All orderings of 0..m-1, for the assignment heuristic (m <= 4 here). */
function permutations(m: number): number[][] {
  if (m === 0) return [[]];
  const out: number[][] = [];
  const rest = permutations(m - 1);
  for (const r of rest) {
    for (let k = 0; k < m; k++) {
      const p = [...r];
      p.splice(k, 0, m - 1);
      out.push(p);
    }
  }
  return out;
}

interface RoomSolution {
  moves: string;
  pushes: number;
  /** Global cell where the player stands when the room is solved. */
  endPlayerGlobal: number;
  expansions: number;
}

/**
 * Solve one room with A* over pushes. `weight` 1 is optimal; a larger weight
 * leans greedy and is the fallback when optimal search runs out of budget.
 * The goal is every box on a goal, with the player still able to reach the
 * door (so it can walk out to the next room), unless requireExit is false.
 * Returns null when the search gives up.
 */
function solveRoom(
  room: Room,
  lv: Level,
  dist: number[][],
  requireExit: boolean,
  maxExpansions: number,
  weight: number,
): RoomSolution | null {
  const n = room.cells.length;
  const m = room.boxes.length;
  const nbr: number[][] = room.cells.map((c) => {
    const out: number[] = [];
    for (let d = 0; d < 4; d++) {
      const [dx, dy] = DIRS[d];
      const x = (c % lv.w) + dx;
      const y = Math.floor(c / lv.w) + dy;
      if (x < 0 || x >= lv.w || y < 0 || y >= lv.h) out.push(-1);
      else out.push(room.local[y * lv.w + x]);
    }
    return out;
  });
  const isGoal = new Uint8Array(n);
  for (const g of room.goals) isGoal[g] = 1;
  // A square is dead when a box on it can never reach any goal, even alone.
  const dead = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    if (isGoal[c]) continue;
    dead[c] = room.goals.every((g) => dist[c][g] === Infinity) ? 1 : 0;
  }
  const perms = permutations(m);
  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const p of perms) {
      let sum = 0;
      let ok = true;
      for (let k = 0; k < m; k++) {
        const d = dist[boxes[k]][room.goals[p[k]]];
        if (d === Infinity) {
          ok = false;
          break;
        }
        sum += d;
      }
      if (ok && sum < best) best = sum;
    }
    return best;
  };
  /** Flood-fill the player's reachable region from `from`, with `boxes` as
   *  obstacles; returns the region and the BFS parent of every cell in it,
   *  so a walk to any reachable cell can be read back. */
  const flood = (
    from: number,
    boxes: number[],
  ): { reach: Uint8Array; parent: Int32Array; parentDir: Int8Array } => {
    const occupied = new Uint8Array(n);
    for (const b of boxes) occupied[b] = 1;
    const reach = new Uint8Array(n);
    const parent = new Int32Array(n).fill(-1);
    const parentDir = new Int8Array(n).fill(-1);
    reach[from] = 1;
    const queue = [from];
    for (let q = 0; q < queue.length; q++) {
      const x = queue[q];
      for (let dir = 0; dir < 4; dir++) {
        const y = nbr[x][dir];
        if (y < 0 || occupied[y] || reach[y]) continue;
        reach[y] = 1;
        parent[y] = x;
        parentDir[y] = dir;
        queue.push(y);
      }
    }
    return { reach, parent, parentDir };
  };
  const walkMoves = (
    from: number,
    to: number,
    parent: Int32Array,
    parentDir: Int8Array,
  ): string => {
    const letters: string[] = [];
    let c = to;
    while (c !== from) {
      letters.push(DIRS[parentDir[c]][2]);
      c = parent[c];
    }
    return letters.reverse().join('');
  };
  /** A 2x2 block of walls/boxes with a box in it and no goal is frozen: none
   *  of those boxes can ever move again. */
  const frozen2x2 = (boxes: number[]): boolean => {
    const occupied = new Uint8Array(n);
    for (const b of boxes) occupied[b] = 1;
    for (const b of boxes) {
      const gc = room.cells[b];
      const gx = gc % lv.w;
      const gy = Math.floor(gc / lv.w);
      for (const [ox, oy] of [
        [0, 0],
        [-1, 0],
        [0, -1],
        [-1, -1],
      ]) {
        const x0 = gx + ox;
        const y0 = gy + oy;
        if (x0 < 0 || y0 < 0 || x0 + 1 >= lv.w || y0 + 1 >= lv.h) continue;
        const cells = [
          y0 * lv.w + x0,
          y0 * lv.w + x0 + 1,
          (y0 + 1) * lv.w + x0,
          (y0 + 1) * lv.w + x0 + 1,
        ];
        let allBlocked = true;
        let hasBox = false;
        let hasGoal = false;
        for (const c of cells) {
          // A wall is blocked; floor outside this room (hallway, another
          // room) is open — only this room's boxes can freeze the block.
          if (lv.wall[c]) continue;
          const li = room.local[c];
          if (li < 0) {
            allBlocked = false;
            continue;
          }
          if (isGoal[li]) hasGoal = true;
          if (occupied[li]) hasBox = true;
          else allBlocked = false;
        }
        if (allBlocked && hasBox && !hasGoal) return true;
      }
    }
    return false;
  };
  const isSolved = (boxes: number[]): boolean => boxes.every((b) => isGoal[b]);

  // A* state: sorted boxes, the player's real square, and the canonical
  // square of its reachable region (the smallest cell in it) used as the key.
  const startBoxes = [...room.boxes];
  const startFlood = flood(room.entry, startBoxes);
  let startCanon = 0;
  for (let c = 0; c < n; c++) {
    if (startFlood.reach[c]) {
      startCanon = c;
      break;
    }
  }
  const keyOf = (boxes: number[], canon: number): string =>
    boxes.join(',') + '|' + canon;
  const sBoxes: number[][] = [startBoxes];
  const sPlayer: number[] = [room.entry];
  const sParent: number[] = [-1];
  const sMoves: string[] = [''];
  const sG: number[] = [0];
  const best = new Map<string, number>([[keyOf(startBoxes, startCanon), 0]]);
  const h0 = heuristic(startBoxes);
  if (h0 === Infinity) return null;
  // Binary heap of [f, h, state index], lowest f first, ties by lowest h.
  const heap: [number, number, number][] = [[weight * h0, h0, 0]];
  const heapLess = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const heapPush = (e: [number, number, number]): void => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0];
    const last = heap.pop() as [number, number, number];
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < heap.length && heapLess(heap[l], heap[s])) s = l;
        if (r < heap.length && heapLess(heap[r], heap[s])) s = r;
        if (s === i) break;
        [heap[i], heap[s]] = [heap[s], heap[i]];
        i = s;
      }
    }
    return top;
  };

  let expansions = 0;
  while (heap.length > 0) {
    const [, , si] = heapPop();
    const boxes = sBoxes[si];
    const g = sG[si];
    const player = sPlayer[si];
    const { reach, parent, parentDir } = flood(player, boxes);
    if (isSolved(boxes) && (!requireExit || reach[room.door])) {
      // Rebuild the move string from the parent chain.
      const parts: string[] = [];
      let cur = si;
      while (cur > 0) {
        parts.push(sMoves[cur]);
        cur = sParent[cur];
      }
      return {
        moves: parts.reverse().join(''),
        pushes: g,
        endPlayerGlobal: room.cells[player],
        expansions,
      };
    }
    if (++expansions > maxExpansions) return null;
    for (let k = 0; k < m; k++) {
      const b = boxes[k];
      for (let dir = 0; dir < 4; dir++) {
        const behind = nbr[b][DIRS[dir][3]];
        const ahead = nbr[b][dir];
        if (behind < 0 || ahead < 0) continue;
        if (!reach[behind]) continue;
        if (boxes.includes(ahead)) continue;
        if (dead[ahead]) continue;
        const next = [...boxes];
        next[k] = ahead;
        next.sort((a, b2) => a - b2);
        if (frozen2x2(next)) continue;
        const h = heuristic(next);
        if (h === Infinity) continue;
        const nf = flood(b, next);
        let canon = 0;
        for (let c = 0; c < n; c++) {
          if (nf.reach[c]) {
            canon = c;
            break;
          }
        }
        const key = keyOf(next, canon);
        const ng = g + 1;
        const prev = best.get(key);
        if (prev !== undefined && prev <= ng) continue;
        best.set(key, ng);
        const idx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(si);
        sMoves.push(walkMoves(player, behind, parent, parentDir) + DIRS[dir][2]);
        sG.push(ng);
        heapPush([ng + weight * h, h, idx]);
      }
    }
  }
  return null;
}

/** Walk the player from `from` to `to` over floor, with `boxes` as obstacles. */
function findWalk(lv: Level, boxes: number[], from: number, to: number): string | null {
  if (from === to) return '';
  const blocked = new Uint8Array(lv.w * lv.h);
  for (const b of boxes) blocked[b] = 1;
  const parent = new Int32Array(lv.w * lv.h).fill(-1);
  const parentDir = new Int8Array(lv.w * lv.h).fill(-1);
  const seen = new Uint8Array(lv.w * lv.h);
  seen[from] = 1;
  const queue = [from];
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q];
    for (let dir = 0; dir < 4; dir++) {
      const [dx, dy] = DIRS[dir];
      const x = (c % lv.w) + dx;
      const y = Math.floor(c / lv.w) + dy;
      if (x < 0 || x >= lv.w || y < 0 || y >= lv.h) continue;
      const n = y * lv.w + x;
      if (lv.wall[n] || blocked[n] || seen[n]) continue;
      seen[n] = 1;
      parent[n] = c;
      parentDir[n] = dir;
      if (n === to) {
        const letters: string[] = [];
        let cur = n;
        while (cur !== from) {
          letters.push(DIRS[parentDir[cur]][2]);
          cur = parent[cur];
        }
        return letters.reverse().join('');
      }
      queue.push(n);
    }
  }
  return null;
}

/** Replay a move string on a level; returns the push count when the replay
 *  is legal and ends with every box on a goal, else null. */
function replay(lv: Level, moves: string): number | null {
  const boxes = new Set(lv.boxes);
  let player = lv.player;
  let pushes = 0;
  for (const ch of moves) {
    const dir = DIRS.find((d) => d[2] === ch);
    if (!dir) return null;
    const [dx, dy] = dir;
    const x = (player % lv.w) + dx;
    const y = Math.floor(player / lv.w) + dy;
    if (x < 0 || x >= lv.w || y < 0 || y >= lv.h) return null;
    const next = y * lv.w + x;
    if (lv.wall[next]) return null;
    if (boxes.has(next)) {
      const bx = x + dx;
      const by = y + dy;
      if (bx < 0 || bx >= lv.w || by < 0 || by >= lv.h) return null;
      const beyond = by * lv.w + bx;
      if (lv.wall[beyond] || boxes.has(beyond)) return null;
      boxes.delete(next);
      boxes.add(beyond);
      pushes++;
    }
    player = next;
  }
  const goalSet = new Set(lv.goals);
  for (const b of boxes) if (!goalSet.has(b)) return null;
  return pushes;
}

/** Solve one level: split into rooms, solve each, stitch with hallway walks. */
function solveLevel(text: string): string {
  const lv = parseLevel(text);
  if (lv.player < 0 || lv.boxes.length === 0) return '';
  const rooms = decompose(lv);
  if (rooms === null) return solveWholeLevel(lv);
  const distCache = new Map<Room, number[][]>();
  const boxesNow = [...lv.boxes];
  let player = lv.player;
  let moves = '';
  for (const room of rooms) {
    if (Date.now() - START_MS > WALL_CLOCK_LIMIT_MS) return '';
    const walk = findWalk(lv, boxesNow, player, room.entryGlobal);
    if (walk === null) return '';
    moves += walk;
    player = room.entryGlobal;
    let dist = distCache.get(room);
    if (!dist) {
      dist = pushDistances(room, lv);
      distCache.set(room, dist);
    }
    let sol = solveRoom(room, lv, dist, true, ASTAR_CAP, 1);
    if (sol === null) sol = solveRoom(room, lv, dist, true, GREEDY_CAP, 3);
    if (sol === null) sol = solveRoom(room, lv, dist, false, GREEDY_CAP, 3);
    if (sol === null) return '';
    moves += sol.moves;
    // The room's boxes are on its goals now; the player stands where the
    // room solution left it.
    const roomGoalCells = new Set(room.goals.map((g) => room.cells[g]));
    const roomBoxCells = new Set(room.boxes.map((b) => room.cells[b]));
    for (let k = boxesNow.length - 1; k >= 0; k--) {
      if (roomBoxCells.has(boxesNow[k]) && !roomGoalCells.has(boxesNow[k])) {
        boxesNow.splice(k, 1);
      }
    }
    for (const gc of roomGoalCells) {
      if (!boxesNow.includes(gc)) boxesNow.push(gc);
    }
    player = sol.endPlayerGlobal;
  }
  // Never hand back a solution the replay does not confirm.
  return replay(lv, moves) === null ? '' : moves;
}

/** Fallback for levels without the hallway/room shape: one A* over the
 *  whole level, with no exit requirement. */
function solveWholeLevel(lv: Level): string {
  const n = lv.w * lv.h;
  const local = new Int32Array(n).fill(-1);
  const cells: number[] = [];
  for (let c = 0; c < n; c++) {
    if (!lv.wall[c]) {
      local[c] = cells.length;
      cells.push(c);
    }
  }
  const room: Room = {
    cells,
    local,
    goals: lv.goals.map((c) => local[c]),
    boxes: lv.boxes.map((c) => local[c]).sort((a, b) => a - b),
    entry: local[lv.player],
    door: local[lv.player],
    entryGlobal: lv.player,
    doorGlobal: lv.player,
  };
  const dist = pushDistances(room, lv);
  let sol = solveRoom(room, lv, dist, false, ASTAR_CAP, 1);
  if (sol === null) sol = solveRoom(room, lv, dist, false, GREEDY_CAP, 3);
  if (sol === null) return '';
  return replay(lv, sol.moves) === null ? '' : sol.moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
