# Rebrand baseline — pre-change test results

Captured on branch `rebrand/agentx-workmate` at the tip of `upstream-baseline`
(`aec331899`), **before** any rebrand edit.

Its only job is to answer one question later: *did my change break this, or was
it already broken?* Without it, the 69 pre-existing Python failures below are
indistinguishable from regressions.

## Results

| Suite | Files | Passed | Failed |
|---|---:|---:|---:|
| Python (`scripts/run_tests.sh`) | 2616 | 25542 | **69** |
| `ui-tui` (vitest) | 138 | 1530 | 0 |
| `apps/desktop` UI (vitest) | 392 | 3405 | 0 |
| `apps/desktop` electron platform | 79 | 935 | 0 |
| `web` (vitest) | 26 | 165 | 0 |
| `tests-js` (vitest) | 3 | 9 | 0 |

Python wall time: 893.5s at 20 workers.

`apps/shared` has no test script — it is covered by `npm run typecheck`.

## The 69 pre-existing Python failures

29 files, listed in `failing-tests.txt`. All are environment-dependent on this
macOS dev box, not code defects:

* **optional media deps not installed** — voice mode, wake word, transcription,
  image/video generation, fal plugin
* **network required** — `test_browser_hardening`, `test_browser_homebrew_paths`
  (both download a browser binary; each burns the 300s per-file timeout twice)
* **Linux-only** — `test_systemd_notify`, `test_service_manager`
* **external services** — Daytona, Modal, Nous Portal, hindsight provider

## Two flaky JS tests

The JS columns above read 0 failures, but two tests assert on wall-clock time
and fail intermittently under CPU load. Both pass 3/3 in isolation, and neither
file is touched by the rebrand (`git diff` against this baseline is empty for
both), so a failure in either is noise, not a regression:

* `ui-tui/packages/hermes-ink/src/utils/execFileNoThrow.test.ts` —
  "settles immediately on 'exit'…" asserts a duration under 500 ms
* `ui-tui/src/__tests__/virtualHistoryOffsetCache.test.ts` —
  "corrects and compensates a same-layout row measured at unmount"

Re-run the single file before treating either as real.

## Reproducing

```bash
scripts/run_tests.sh                              # Python
npm run build:ink --prefix ui-tui                 # required once before JS tests
npm test --prefix ui-tui
npm run test:ui --prefix apps/desktop
npm run test:desktop:platforms --prefix apps/desktop
npm test --prefix web
npm test --prefix tests-js
```

`full-run.log.gz` holds the complete Python run for line-level comparison.
