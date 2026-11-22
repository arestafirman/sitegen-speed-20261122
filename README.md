# Single-pass makefun-site drop-in

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/arestafirman/sitegen-speed-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/arestafirman/sitegen-speed-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0: `solve.js` (Node 22, stdlib only, dependency-free) rebuilds the exact same static site — same front matter, template dialect, Markdown subset, slug rule and build report, byte for byte — in a single pass. `main.ts` is the house driver, unchanged; only `solve.js` is rewritten.
