# Tersio Benchmark Guide

This guide shows how to measure Tersio on any AI coding agent. Tersio works with many agents. Use the same steps for each agent, and report the agent and model you used.

The method follows how the upstream projects test their own tools:

- **Caveman:** Compare replies on fixed prompts. Add a control prompt, `Answer concisely.`, so the gain is not just from a short-answer instruction. Count the prompt overhead separately. Report losses.
- **Ponytail:** Run the same agent with and without the skill. Repeat each task 5 times. Check quality with tests, injected bugs, and security tasks.
- **RTK:** Measure command output only. Check that failure details survive compression. Report percentages, not bill savings.

## 1. Modes

Base means all modes are off. Every result is compared to base.

| Mode | Setting | What it changes |
|---|---|---|
| Base | `off` | Nothing. This is the baseline. |
| Control | `Answer concisely.` | A plain instruction. Used only as a reference. |
| Caveman | `lite`, `full`, `ultra` | Shorter replies. |
| RTK | `on` | Shorter shell command output. |
| Ponytail | `lite`, `full`, `ultra` | Smaller code changes. |
| pstack | `on` | Design and verification rules. Scored on quality only. |
| Combo | `medium`, `balanced`, `max` | Presets that set Caveman, RTK, Ponytail, and pstack together. |

Set modes through saved defaults. Do not use a command prefix. Some modes add text at session start, and a prefix can skip that step.

## 2. Setup

1. Install Tersio for your agent. Run the health check and confirm it passes.
2. Record the agent version, model, thinking level, and temperature. Keep them fixed for all runs.
3. Write benchmark output to a separate folder. Do not change your live settings.
4. Use a fixed test repository with a passing test suite and at least 200 files.
5. Make a copy with exactly one failing test. Use it for the agentic and RTK tests.
6. Pin the repository to one commit. Do not change it during the test.

## 3. Test Surfaces

Run each mode on each surface. Do not combine results from different surfaces.

| Surface | Task | What is counted |
|---|---|---|
| Prose | 3 prompts, each asking for a three-sentence explanation. | Reply tokens |
| Code | 3 prompts, each asking for TypeScript functions. | Reply tokens |
| Agentic | Run the test suite. Fix the failing test. Stop when it passes. | Total tokens, time, pass rate |
| Command output | Run 4 shell commands with and without RTK. | Output tokens, time, fidelity |
| Prompt overhead | Count the text each mode adds to every turn. | Block |

## 4. Procedure

1. Set all modes to `off`. Run the base case.
2. Set one mode or preset. Run it on the same prompts.
3. Start a new session for each run.
4. Run each case **5 times**. Record every result. Do not drop slow or failed runs.
5. Interleave the modes. For example: base, mode A, mode B, base, mode A, mode B.
6. Run the control prompt `Answer concisely.` on the prose surface.

## 5. Metrics

| Symbol | Name | Formula |
|---|---|---|
| **Block** | Prompt overhead | Tokens the mode adds to each turn. Base is 0. |
| **Δ Tokens** | Reply change | Median reply tokens − base median. Negative is a saving. |
| **Δ Net** | First-turn effect | Block + Δ Tokens. Negative means the mode saves overall. |
| **Δ Time** | Time change | Median time − base median. |
| **Δ%** | Relative change | Δ ÷ base median × 100. |
| **Quality** | Pass rate | Passing runs out of 5. |

Always read Δ Net next to Δ Tokens. A mode can cut reply tokens and still cost more overall.

## 6. Quality Checks

A saving only counts if the output is still correct.

- **Code:** Passes a strict type check. Passes a fixed test file. Contains every requested function.
- **Prose:** Exactly three sentences. Contains the required keywords for each prompt.
- **Agentic:** The test suite passes. No test file was edited.
- **Command output:** The failing test name, assertion message, file, and line remain. The exit code matches the plain command.
- **pstack:** Score the agentic pass rate, the number of review rounds, and wrong turns. A green suite with a wrong turn counts as a failure.

### The fixed prompts and keyword lists

Two people running this guide must measure the same thing, so the prompts and the keyword groups are fixed here. A group matches when the reply contains any of its terms as a substring, so `quer` covers `query` and `queries`, and `concurren` covers `concurrent` and `concurrency`.

| Prompt | Text | Keyword groups, all required |
|---|---|---|
| P1 | Explain in three sentences how a database connection pool improves throughput under load. | `reus` · `connection` · `overhead`/`cost` · `concurren`/`wait` |
| P2 | Explain in three sentences why an index speeds up a database query. | `index` · `quer` · `scan`/`search`/`tree`/`lookup` · `rows`/`table`/`data`/`disk` |
| P3 | Explain in three sentences how HTTP caching reduces server load. | `cach` · `server`/`origin`/`backend` · `load`/`bandwidth`/`request`/`traffic` |

| Code prompt | Text | Required names |
|---|---|---|
| C1 | Write a TypeScript function `chunk<T>(items: T[], size: number): T[][]` that splits an array into fixed-size chunks, and `chunkLazy` that yields chunks from an iterable without materializing the whole array. | `chunk`, `chunkLazy` |
| C2 | Write a TypeScript function `debounce` and a function `throttle`, both with the signature `(fn: (...args: T) => void, ms: number)`. | `debounce`, `throttle` |
| C3 | Write a TypeScript function `groupBy<T, K extends PropertyKey>(items: T[], key: (item: T) => K): Record<K, T[]>` and `countBy` with the same inputs returning `Record<K, number>`. | `groupBy`, `countBy` |

| Agentic | Text |
|---|---|
| A | In the fixture repo, run the test suite. Fix the failing test. Stop when all tests pass. |

The keyword test is lexical, so a reply that explains the right idea in another word misses the group and fails. Read the reply before recording a miss as a quality failure, and compare every mode against base on the same prompt: a group the base model also misses measures the gate, not the mode.

Do not publish a saving for any mode with a lower pass rate than base.

## 7. Results Template

Leave cells blank until measured.

### Prose Surface

| Mode | Block | Δ Tokens | Δ% | Δ Net | Quality | Median Tokens |
|---|---:|---:|---:|---:|---:|---:|
| Base (`off`) | 0 | 0 | 0% | 0 | ___/5 | ___ |
| Control (`Answer concisely.`) | ___ | ___ | ___% | ___ | ___/5 | ___ |
| Caveman `lite` | ___ | ___ | ___% | ___ | ___/5 | ___ |
| Caveman `full` | ___ | ___ | ___% | ___ | ___/5 | ___ |
| Caveman `ultra` | ___ | ___ | ___% | ___ | ___/5 | ___ |

### Code Surface

| Mode | Block | Δ Tokens | Δ% | Δ Net | Quality | Median Tokens |
|---|---:|---:|---:|---:|---:|---:|
| Base (`off`) | 0 | 0 | 0% | 0 | ___/5 | ___ |
| Ponytail `lite` | ___ | ___ | ___% | ___ | ___/5 | ___ |
| Ponytail `full` | ___ | ___ | ___% | ___ | ___/5 | ___ |
| Ponytail `ultra` | ___ | ___ | ___% | ___ | ___/5 | ___ |

### Agentic Surface

| Mode | Block | Δ Tokens | Δ% | Δ Net | Δ Time | Quality |
|---|---:|---:|---:|---:|---:|---:|
| Base (`off`) | 0 | 0 | 0% | 0 | 0 | ___/5 |
| RTK `on` | ___ | ___ | ___% | ___ | ___ | ___/5 |
| Combo `medium` | ___ | ___ | ___% | ___ | ___ | ___/5 |
| Combo `balanced` | ___ | ___ | ___% | ___ | ___ | ___/5 |
| Combo `max` | ___ | ___ | ___% | ___ | ___ | ___/5 |
| pstack `on` | ___ | n/a | n/a | n/a | ___ | ___/5 |

pstack is scored on quality and review rounds only. Its token columns are not used.

### Command Output (RTK)

| Command | Base Tokens | RTK Tokens | Δ | Δ% | Δ Time | Fidelity |
|---|---:|---:|---:|---:|---:|---:|
| `bun run test` | ___ | ___ | ___ | ___% | ___ | Pass / Fail |
| `find . -name '*.test.ts'` | ___ | ___ | ___ | ___% | ___ | Pass / Fail |
| `ls -la .` | ___ | ___ | ___ | ___% | ___ | Pass / Fail |
| `git status` | ___ | ___ | ___ | ___% | ___ | Pass / Fail |
| `grep -rn pattern src/` | ___ | ___ | ___ | ___% | ___ | Pass / Fail |
| `cat README.md` | ___ | ___ | ___ | ___% | ___ | Pass / Fail |
| `gh pr list` | ___ | ___ | ___ | ___% | ___ | Pass / Fail |
| `tsc --noEmit` | ___ | ___ | ___ | ___% | ___ | Pass / Fail |
| `rtk read src/main.ts --level aggressive` | ___ | ___ | ___ | ___% | ___ | Pass / Fail |
| `rtk err <build command>` | ___ | ___ | ___ | ___% | ___ | Pass / Fail |

RTK token counts use a bytes ÷ 4 estimate. Use the percentages for comparison. Do not treat the token counts as exact.

Use real commands from the repo under test. Placeholder paths such as `src/` measure nothing. A clean `tsc` or an empty `gh pr list` prints almost nothing, so those rows need a repo with output. The read row measures the direct call, because `cat` rewrites to `rtk read` at the default level, which keeps the full body and saves nothing.

For every row, check that the condensed output still carries what the task needs. A failing test keeps its name, its assertion, and its file and line. A search keeps its matches. A read at `--level aggressive` keeps signatures and imports, not full bodies.

Measured on the Tersio repo, 2026-10-15, rtk 1.0.1, for scale:

| Command | Δ% | Note |
|---|---:|---|
| `find . -name '*.test.ts'` | 99.2% | 51,787 B to 416 B |
| `rtk err bun run build` | 94.4% | 846 B to 47 B |
| `ls -la .` | 72.5% | 2,155 B to 592 B |
| `git status` | 19.2% | low here because 136 staged files are listed |
| `rtk read <file> --level aggressive` | 66–76% | on 8 KB to 47 KB sources |
| `rtk read <file> --level minimal` | 9–14% | keeps most of the body |
| `rtk read <file> --max-lines 60` | 58–96% | structural preview |
| `bun run test` | 0% | the summary is already 198 B |

Fidelity held on every row tested: 22 of 22 grep matches survived at identical size, a failing test kept its name, its assertion, and its `file:line`, and `rtk err` kept the exact failure text and exit code.

## 8. Reporting

Include these items with every result:

- Agent name and version.
- Model, thinking level, and temperature.
- Tersio, RTK, Ponytail, and Caveman versions.
- Test repository and commit.
- Number of runs (N), the date, and the surface.

Show the median, min, and max for each value. Write verdicts with the limits. For example: "Lower reply tokens in this sample. Quality unchanged on 5 of 5 runs."

Do not claim total bill savings. The tests measure reply tokens, prompt overhead, or command output. Rerun the tests when you change the agent, model, or Tersio version. Do not compare results across different setups.
