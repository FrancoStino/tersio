# ERRORS.md

Recurring mistakes log. Committed to git; reviewed periodically to promote entries into permanent rules in `AGENTS.md` or linter config.

## Promoted and cleared

Reviewed 2026-10-11. Each entry below is resolved in the repo, so its log entry is gone and the guard is named here.

| Mistake | Permanent guard |
|---|---|
| Unpriced model read as unknown instead of aliased | `MODEL_ALIASES` in `extensions/shared/pricing.ts`, pinned by `test/shared/pricing.test.ts` |
| React duplicate chased with four config knobs | `vitest.config.ts` runs `dashboard/app` as its own project, so it uses its own React |
| Test script split broke `bun run test -- <path>` | one `vitest run` with `test.projects`; forwarding verified at 1 file |
| Host hook wired against an assumed payload shape | `test/extensions/server-sessions.test.ts` fires the hook with the real shape |
| `COUNT` with an `ELSE 0` literal counted every row | `extensions/shared/agent-stats.ts` writes `COUNT(CASE WHEN … THEN 1 END)`; `test/cli/omp-stats.test.ts` pins the throughput |
| Rounding stored values before deriving metrics | `round4` applies only to the output series; the same test pins the derived figure and the series |
| A row field no reader filled left a column blank | the same test asserts `row.provider` for every grouped row shape |
| A unit test imported a component file under the root tsconfig | pure logic lives in `dashboard/app/src/lib/*.ts`; `test/tsconfig.json` includes `.ts` only |
| Slow-CI timeout on a heavy test that passed locally | `vitest.config.ts` sets `testTimeout: 30000`, so no test relies on the 5s framework default |
| Benchmark probes raced the sweep over shared settings file | `docs/BENCHMARK.md` exports `TERSIO_HOME` into the throwaway dir, so a run never opens the live settings file for writing |
| Pixel harness measured live data and live animations | `test/repo-integrity.test.ts` fails if any chart sets `isAnimationActive` to true, so a JS entrance animation cannot return |
| A type-import split dropped an existing type import | `bun run build` runs `tsc`, and `bun run verify` runs the build, so a dropped name fails the build |
| Two edits rewrote a span they only half re-emitted | the same `tsc` step; the half-rewritten interface and the dropped field are compile errors |
| Backticks nested inside a template-literal code generator | the generator is gone; no tracked script writes markdown from a template literal |

## Format

```md
## YYYY-MM-DD — <short title>
**What happened:** Describe the mistake or unexpected behavior.
**Root cause:** Why it happened.
**Prevention rule:** What to do differently next time.
```

## The entries that stay

The eight entries below are editing and verification discipline. No test, lint rule, or config can pin them, because each one describes a choice made while writing the change rather than a state the repo ends in. They stay as written.

## 2026-10-10 — Line-range deletions computed against a list an earlier deletion had shifted
**What happened:** A python pass deleted two function blocks from `extensions/shared/agent-stats.ts` by line range. The first deletion lowered every later index, and the second range used indices read before that deletion, so it cut the middle of `readSessionTrace` instead of the gain block. The file lost 168 lines of live code while the target functions survived.
**Root cause:** Computed all the line anchors, then applied the deletions one after another, so only the first range was still valid.
**Prevention rule:** Delete one span at a time, or match anchors by text, never by a precomputed line number. After any multi-span deletion, `git diff --stat` must show the expected line count per file before the build.
**Verification note:** `git checkout <file>` restored the file; the second attempt used string anchors.

## 2026-09-23 — Malformed oldString/newString boundary in edit calls
**What happened:** `edit` calls produced broken intermediates: a stray `async function` declaration line, a dropped `const SOURCES` opener, duplicated function headers, and deleted neighbors in dashboard/app.js. Each was caught by reading the edited region right after and repaired before building.
**Root cause:** Drafting replacement text that overlapped neighboring declarations instead of keeping the boundary to the exact lines being changed.
**Prevention rule:** Keep every edit boundary to the smallest requested change; read the edited region immediately after each structural edit and repair before moving on. Prefer python-script replacement for large JS block swaps.

## 2026-10-06 — Pasted a numbered diff with stale line ranges into `edit`
**What happened:** An `edit` call was given a `PUT 89.=90` body pasted from a `git diff` fragment instead of the file's real content. It silently dropped `expect(existsSync(usageDbPath())).toBe(true);` from a test. The same pattern later removed the body of a whole test and a `mkdtempSync` line from another file.
**Root cause:** Drafted patch hunk numbers from diff output and reused them as line coordinates. Diff line numbers are hunk offsets, not file coordinates, and a body copied from one file does not describe the target file.
**Prevention rule:** Never paste a diff fragment into `edit`. Read the target region first, then write the smallest literal replacement. Treat any edit that removes an assertion or a statement you did not intend to remove as corrupt: re-read the region immediately.

## 2026-10-06 — Edit body dropped a line the replacement was meant to keep
**What happened:** A `PUT 642.=643` edit in `cli/dashboard.ts` added an `onError` reject handler, but the replacement body omitted `let stopping = false;`. Two functions kept referencing the missing variable until the build caught it with three TS2304 errors.
**Root cause:** The replacement body listed only the new lines. A range PUT replaces the entire range, so any surviving line inside it must be re-emitted in the body.
**Prevention rule:** After an edit that inserts inside a block, read the whole block and confirm every referenced variable is declared. When drafting a replacement body, re-emit each surviving line from the target range.

## 2026-10-07 — RTK coverage judged from a savings summary instead of the rewrite registry
**What happened:** Reported `bun` (1120 calls) and `bunx` (481 calls) as uncovered gaps because neither appeared in `rtk gain`'s top-10 list. Direct probing showed both rewrite (exit 3).
**Root cause:** Treated a savings summary as a coverage report. `rtk gain` ranks by tokens saved, so a rewritten command with small output never appears in it.
**Prevention rule:** Probe `rtk rewrite "<command>"` for coverage: exit 0/3 with stdout means covered, exit 1 means passthrough. Never infer it from `rtk gain` or `rtk session`, which scans Claude Code history only.

## 2026-10-07 — Edit truncated an existing test while trying to insert before it
**What happened:** Adding two new tests to `test/cli/host-menus.test.ts`, the `oldText` spanned a whole existing test and the `newText` contained only that test's opening line. The replacement deleted the body and the closing brace, leaving a parse error at EOF. It also silently dropped an existing assertion before tsc caught the syntax break.
**Root cause:** Used a replacing primitive for an insertion. A range replacement rewrites the entire matched span, so anything intended to survive must be re-emitted in full.
**Prevention rule:** To insert before a block, keep `oldText` to the insertion point alone, or re-emit the whole original block in `newText`. After editing near an existing test, run `git diff -U0 -- <file>` and confirm the change is pure insertion before running the suite.

## 2026-10-10 — A page recomputed a figure the payload already carried
**What happened:** The Providers and Models tables derived throughput as total output tokens divided by average duration, which read 173,158/s where the payload's own `avgTokensPerSecond` read 64.8. A live screenshot caught it, not a test.
**Root cause:** Reached for the two fields that were in front of me instead of the one field the contract already defines for that metric.
**Prevention rule:** Before computing anything from raw fields, check whether the payload carries the finished metric. Render the page and read the numbers once before calling it done.

## 2026-10-10 — A UI check read a stale build
**What happened:** Screenshots and DOM probes against the dashboard reported duplicated month labels, a wrong cell count, and a legend that ran off the card. The source was correct in each case, or already fixed.
**Root cause:** The server ran `dist/tersio.js` from a build made before the last edits, so every probe measured the old bundle.
**Prevention rule:** Restart the server after `bun run build`, and confirm the served bundle dates from this session before trusting a visual or DOM result.

## 2026-10-12 — A tier assertion read the live price cache, so it passed only where that cache exists
**What happened:** `test/cli/usage-tokens.test.ts` asserted a resolved tier for `deepseek/deepseek-v4.1-flash` with no `TERSIO_PRICES_FILE` set, so `loadLivePrices()` fell through to `~/.tersio/prices.json`. That file exists on the developer's machine and nowhere in CI, so the tier resolved `tail` locally and `default` on the runner. The whole suite went green locally; CI failed one test on the next push.
**Root cause:** Wrote an assertion against a cache the host owns, while every neighbouring test in the same file already built its own feed with `setEnv`. The one test that skipped the convention was the one that read machine state.
**Prevention rule:** Any assertion about a resolved price tier, a `known` flag, or a rate must point `TERSIO_PRICES_FILE` at a file the test writes. Prove it by running the file with `HOME` set to an empty temporary directory before pushing, which reproduces the runner's missing home exactly.

## 2026-10-13 — omp staleness was compared against a directory omp never loads
**What happened:** The per-host add-on check used `<pkg>/dist/extensions` as omp's tree, because omp's plugin runs compiled output. The plugin manifest actually names `./extensions/caveman/index.ts`, the source tree, and `dist/extensions` is only a shipped file. Every `omp/caveman/*` staleness row was therefore a false positive, and the repair could not clear it because it syncs `extensions/`, not `dist/`.
**Root cause:** Inferred the loaded path from the word `dist` instead of reading the installed `package.json's `omp.extensions` field, which names the exact files. The same file already held an `Extension tree` check reading the right directory.
**Prevention rule:** Resolve a host's loaded path from its manifest field (`omp.extensions`), never from a build-output convention. When a staleness row cannot be cleared by its own repair command, suspect the compared path before the comparison.

## 2026-10-13 — A version spec installs the published package, so a local dependency bump is inert
**What happened:** `package.json` pinned `@dietrichgebert/ponytail: ^5.1.0` locally while the installed plugin stayed on 4.13.0. Both tersio copies are 2.25.5, but the published one declares `^4.12.0`, so `npm install` in the plugins dir kept resolving 4.x. The repair read the installed tersio's manifest, reinstalled 4.x forever, and the version row never cleared. Worse, `install`'s own step deleted the pin, after which npm pruned ponytail out of `node_modules` entirely and the row went `MISSING`.
**Root cause:** Two repair paths disagreed about whether the standalone dependency should exist. The spec is a version, not a path, so the published manifest wins every time unless the local range is pinned explicitly.
**Prevention rule:** When a dependency range is bumped locally and the consumer is installed by version spec, pin that range in the installed package too, and make every repair path read it from one shared helper. Prove it by checking the installed package's own declared range, not the local repo's.

## 2026-10-13 — A pinned version sat next to a nested copy, and the check read the wrong one
**What happened:** `@dietrichgebert/ponytail` was pinned `^5.1.0` in `~/.omp/plugins/package.json`, and the version row reported 5.1.1. Module resolution from the installed extension landed in `node_modules/@krtclcdy/tersio/node_modules/@dietrichgebert/ponytail`, version 4.13.0. npm nests that copy because the published tersio's own `^4.12.0` range excludes the pin, and Node resolves the nearest `node_modules` first. The row read the top-level copy, so the decoy was invisible, and the per-host body comparison used the same decoy as its reference.
**Root cause:** Assumed a dependency entry decides which copy loads. It decides the hoisted copy only; the pinned version can never satisfy the plugin's own older range, so npm is obliged to nest one and every import takes the nested one. Verified by deleting the override, running `npm install`, and watching the row change from `5.1.1` to `4.13.0`.
**Prevention rule:** When a reported version can differ from the version that runs, resolve the path the way the runtime does (nearest `node_modules` from the file that imports it) and assert the two agree. For npm nesting, write an `overrides` entry alongside the dependency entry.

## 2026-10-13 — A parity check read a path the host never loads
**What happened:** The Ponytail per-host body check compared pi against `~/.pi/agent/extensions/ponytail/hooks/ponytail-instructions.js`. pi installs Ponytail as a local path package, so the file that loads is inside the directory `~/.pi/agent/settings.json` names, and the read path there is never written. `readTextIfExists` returns null for it, the loop `continue`d, and pi was silently dropped from the comparison. The live copy differed from the loaded reference by a full hash and the row said nothing.
**Root cause:** Built the path from the layout of the other hosts instead of from the host's own registration. The same check already contains the answer: it reads pi's settings.json to detect the host, and that file names the directory.
**Prevention rule:** For a package a host installs as a local path, resolve the path from the host's registration file, never from a sibling host's layout. Then prove the check can fail: seed a drifted copy and see the row name the host, or the check is dead code.

## 2026-10-13 — A parity check compared the subject against itself
**What happened:** The per-host add-on check used the installed plugin package (`~/.omp/plugins/node_modules/@krtclcdy/tersio/extensions/…`) as the reference bytes for every host. For omp that directory *is* the subject, so omp's tree was compared against itself and always matched. `rtk/session.ts` and `combo/index.ts` differed from this working tree by comment-only edits, and doctor reported `Extension tree: ok 19 files ok`.
**Root cause:** Picked the reference because it was the obvious "installed" copy, without asking what it would prove. A self-comparison cannot detect anything, which is the same failure mode as comparing a `dist` directory no manifest names.
**Prevention rule:** For every parity check, name the subject and the reference, and confirm they are two different directories. When the reference can be the subject, the check is decoration. Prove it by making the subject differ and watching the row appear.

## 2026-10-13 — pi's RTK extension files were installed and unreachable

**What happened:** pi loaded no RTK mode surface. `rtk/session.ts` and `rtk/filter.ts` sat on disk with byte-identical content to the repo, and pi never ran them, so `/rtk`, `rtk_run`, the prompt block, and the grep and glob filter were all absent on one of three supported hosts.

**Root cause:** pi discovers a subdirectory only when it holds an `index.ts`, an `index.js`, or a `package.json` with a `pi.extensions` field. The installer copied the two files into `rtk/` and wrote no entry point, so the loader skipped the directory. A byte-comparison check cannot see this class of bug: every file was correct, and none of them loaded.

**Prevention rule:** Byte equality is not reachability. After changing what an install writes, run the host's own loader and confirm the entries come back. Compare files against the repo as a second check, never as the only one.

## 2026-10-13 — A manifest path through `node_modules` never resolved in a package

**What happened:** `package.json` `omp.skills` named `./node_modules/@dietrichgebert/ponytail/skills`. It resolved in the repo and in no installed copy, because npm hoists the dependency to the plugins root.

**Root cause:** The declaration was written against a checkout, where the dependency is a top-level directory. In the published tree the nested path is empty, so the entry was dead weight. The skills still loaded, from the dependency's own `pi.skills` declaration, which hid the fault: the list looked right for the wrong reason.

**Prevention rule:** A manifest may not name a path inside `node_modules`, because the install decides where that directory lives. Declare what the package owns; let a dependency declare its own. A green list is not proof the declaration was read.

## 2026-10-13 — `/rtk off` stopped the prompt and not the rewrite

**What happened:** On OpenCode, turning RTK off removed the prompt block and left the bash rewrite running, so commands kept being rewritten by a mode the user had switched off.

**Root cause:** The `execute.before` hook called the rewrite with no mode check, while the `execute.after` filter twenty lines below it read `rtkActive`. The gate existed, on the wrong branch. On omp and pi the same switch worked, because there the session extension writes `RTK_DISABLED`, which the rtk-authored `rtk.ts` reads.

**Prevention rule:** When two hooks share a mode, read it in both or in neither. A gate on one path reads as coverage while the other path stays open.

## 2026-10-13 — A column nothing wrote and a read that never selected it

**What happened:** Time to first token read `—` for every pi request, and for every OpenCode request too. The store held the column, the page rendered the field, and the numbers were empty at both ends.

**Root cause:** Three separate faults in one chain, each invisible from the other side. pi records `durationMs` and never a first-token field, so there was nothing to read. OpenCode records `time.streamed`, but the v2 query never selected it and the row builder hardcoded `tf: undefined` beside it. And the dashboard's own `readUsageDb` never selected the `tf` column, so even a populated store read back null. Each layer looked correct while the one above it was empty.

**Prevention rule:** A metric needs a writer, a reader, and a check that they name the same thing. When a column is always null, walk the chain before assuming the host records nothing. Adding a column means touching the insert, every select, and the row builder; grep for the column name and count the sites.

## 2026-10-13 — A helper hardcoded the value it was meant to carry

**What happened:** OpenCode's stored rows set `tf: undefined` by hand while the parser beside it computed a real latency, so the field could never hold a value.

**Root cause:** The row builder was written before the host recorded latency and was never revisited when the source did. A literal `undefined` beside a computed field reads as "not applicable" rather than "not wired".

**Prevention rule:** A field that is always a literal is either a decision or an oversight; say which in the code. When a source starts carrying a value, grep for the field name, not the feature name.

## 2026-10-13 — pi failed to start on a retired extension the installer kept writing
**What happened:** `pi` exited with `Failed to load extension ".../tersio-commands/index.ts": Cannot find module '../ai-addons-updater/index.ts'`. The tree held a stale `tersio-commands/` whose import target, `ai-addons-updater/`, had already been emptied. pi auto-discovers every `index.ts` under `<agent-dir>/extensions`, so one stale file broke the host.
**Root cause:** Two debris lists existed. `cli/install.ts` `RETIRED_OMP_AGENT_DIRS` named both `tersio-commands` and `ai-addons-updater`, but the shared `OBSOLETE_DIRS` in `cli/manifest.ts` — the one detection and the doctor repair both read — named only `ai-addons-updater`. So the repair deleted the import target and left the importer, which is worse than leaving both: a stale directory that no longer resolves. Separately, the repair removed debris *files* and left empty debris *directories* behind, so the shell kept listing retired names.
**Prevention rule:** One debris definition, one list, read by every path. When a repair removes a directory's contents, remove the directory too, or the tree keeps advertising a name nothing serves.

## 2026-10-13 — OpenCode could not start: its own service manager had lost its daemon
**What happened:** `opencode service start` and `service restart` both exited 1 with `Managed service port 49374 on 127.0.0.1 is already in use by another process`, while `opencode service status` answered `stopped`. A daemonized `opencode serve --service` (pid 85672, reparented to init) still held the port. `service stop` and `service restart` could not reach it, so every documented remedy failed.
**Root cause:** The manager's view of its process and the actual process had diverged, and its status command is the only signal it offers. Nothing in the loop could see the orphan, so the port looked free.
**Prevention rule:** When a report and a resource disagree, trust the resource. The check that matters is the one that reads the port and the process directly, and the remedy that works is the one that acts on the process, not on the manager that lost it. Validate a pid read from another process before signalling it.

## 2026-10-14 — A green local run on a test that read the machine's own home

**What happened:** `test/extensions/server-sessions.test.ts` passed locally and failed on CI in 49 seconds, on the pushed commit. The assertion was `expect(joined).not.toMatch(/PONYTAIL MODE ACTIVE/)` for a pi host, and CI saw the Ponytail block present. The suite reported 472 passed here and 469 passed, 1 failed, 2 skipped there.

**Root cause:** The skip needs two conditions, `isPiProcess() && piHasUpstreamPonytail()`. The test set the env var and left `PI_CODING_AGENT_DIR` unset, so the second condition read `$HOME/.pi/agent` for a marker file. This machine has the pi Ponytail extension installed, so the marker existed and the skip fired. A CI runner has no `~/.pi`, so the hook fell back to injecting Ponytail and the assertion failed. The test proved that a marker existed somewhere on the machine, not that the code read one.

**Prevention rule:** A test that asserts on an on-disk condition must pin the path it reads. Redirect the directory the code resolves, or the test measures the developer's machine. Reproduce a CI-only failure by running the file with an empty `HOME` before touching the code; the same empty `HOME` then proves the fix.

## 2026-10-14 — A test read a package file the install had already pruned

**What happened:** A new assertion read `.omp/plugins/node_modules/@krtclcdy/tersio/package.json` after spawning the real installer into a temp home, and it failed with ENOENT on a home the same test had planted that file into moments before.

**Root cause:** The planted home held Tersio and no Ponytail, so `stepPonytail` found no `pi-extension/index.js`, took the slow path, and ran `npm install` over the plugins directory. A package with no lockfile entry behind it is pruned by that install, and with no registry reachable it is not restored, so the planted manifest was gone by the time the assertion ran. The install's own writes survived only because they recreate `extensions/` after the package step.

**Prevention rule:** A test that spawns the installer asserts on files the install writes, never on files the test planted beside them. Assert a package manifest through the repair path (`tersio doctor --fix extensions`), which runs no package manager, and treat any dependency on npm or bun as a host condition to pin rather than one to assume.
