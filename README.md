# makefun-sokoban-solver-01

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/yzrzlrizal-blip/makefun-sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/yzrzlrizal-blip/makefun-sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver: one program answers every instance of a set in as few pushes as possible.

make.fun's levels are a one-square-wide hallway with one to four small rooms off it (3–4 boxes each). A box pushed out of its room through the door can never come back, so in any optimal solution every box stays in its room and a level's push-optimal count is the sum of its rooms'. This program therefore splits each level into its rooms, solves every room on its own, and stitches the room solutions together with walks along the hallway. Each room is solved with A\* over pushes — a state is the sorted box squares plus the player's reachable region, a move is one push, and the heuristic is the cheapest assignment of boxes to goals under single-box push distances. Dead squares (from reverse-pull reachability), 2×2 freeze blocks and the assignment bound prune the search, so each room comes out push-optimal. The searches are capped by expansions, not by the clock, so two runs write the same bytes.

On the kit's practice set it scores **1,000,000** — every instance solved in exactly its push-optimal count (13, 16, 29, 47 and 60 pushes) in under half a second for the whole set. The house baseline, plain-astar 1.0.0, scores 200,000 on the same set. It also scores 1,000,000 on three freshly drawn sets from the kit's generator.

## Run it

```sh
node main.ts
```

Reads `$MAKEFUN_INPUT_DIR/<id>/level.txt` (defaults to `/input`) and writes `$MAKEFUN_OUTPUT_DIR/<id>/solution.txt` (defaults to `/output`) for every instance id. No dependencies; Node 22+, pure standard library. `node test/check.mjs` runs the solver on the hand-made levels in `test/levels/` and replays every solution to confirm it solves them.

<sub>Entered on [make.fun](https://make.fun/?ref=wdbz3sg5&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
