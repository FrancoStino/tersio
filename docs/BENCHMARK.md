# Running the Tersio Benchmark

A protocol, not a result. Run it on your machine and publish your numbers. Replace `<host>` with
your host binary. Models change, so numbers differ.

## 1. What you measure

Three surfaces. Never average them together.

| Surface | Counts | Does not count |
|---|---|---|
| Reply | Tokens in the answer (`usage.output`, includes reasoning) | Prompt overhead, tool results |
| Prompt overhead | Tokens a mode adds to every turn | The answer |
| Command output | Tokens in shell output | Everything else |

Two axes: **tokens** (`usage.totalTokens`, summed over assistant turns) and **time** (wall-clock
around the process, median of N).

Savings are eligible-only: a percentage applies to redundant output — repeated errors, a build log
repeating one warning, an oversized dump. Clean output saves near zero; that is the mode working.
Report the fixture each number came from.

A mode can cut reply text and still lose: its prompt cost is paid on every turn.

## 2. Setup

```bash
tersio doctor            # must pass
rtk --version
<host> --version
bun --version
export BENCH_TMP="$(mktemp -d)"              # sessions, stdout, and results land here
export TERSIO_HOME="$BENCH_TMP/tersio"       # settings, usage ledger, and caches land here
```

`TERSIO_HOME` is what the settings store resolves through, so the CLI and the host's extensions
share it and the live `~/.tersio/settings.json` is never written. Two writers on one file once
measured a partial mode block.

**Fixture.** Never run tools against the live repo; its size changes between runs. Pin a fixed commit
that has:

- a passing test suite,
- one copy with exactly one failing test,
- at least 200 files for the `find` cases.

Keep results out of git: write to `$BENCH_TMP`, or `benchmark/results/` only if that path is ignored.

## 3. Modes and prompts

| Mode | Command | Levels |
|---|---|---|
| Caveman | `/caveman <level>` | `lite`, `full`, `ultra`, `megacave-lite`, `megacave-full`, `megacave-ultra` |
| Ponytail | `/ponytail <level>` | `lite`, `full`, `ultra` |
| Combo | `/combo <level>` | `medium` (caveman `lite` + rtk + ponytail `lite`), `balanced` (`full`/`on`/`full`), `max` (`ultra`/`on`/`ultra`) |
| RTK | `/rtk on` | `on` |

Set the mode through saved defaults, not a `/command` prefix: Ponytail and RTK inject at session
start, and a prefix can leave the recorded prompt unchanged.

Also run each mode on the other surface — Caveman on code and Ponytail on prose show which part of
a Combo gives the saving. Use three prompts per surface.

| Surface | Prompts |
|---|---|
| Prose | P1: Explain in three sentences how a database connection pool improves throughput under load.<br>P2: Explain in three sentences why an index speeds up a database query.<br>P3: Explain in three sentences how HTTP caching reduces server load. |
| Code | C1: Write a TypeScript function `chunk<T>(items: T[], size: number): T[][]` that splits an array into fixed-size chunks, and `chunkLazy` that yields chunks from an iterable without materializing the whole array.<br>C2: Write a TypeScript function `debounce` and a function `throttle`, both with the signature `(fn: (...args: T) => void, ms: number)`.<br>C3: Write a TypeScript function `groupBy<T, K extends PropertyKey>(items: T[], key: (item: T) => K): Record<K, T[]>` and `countBy` with the same inputs returning `Record<K, number>`. |
| Agentic (tools on) | A: In the fixture repo, run the test suite. Fix the failing test. Stop when all tests pass. |

## 4. Run procedure

```bash
run() {  # run <caveman> <ponytail> <rtk> <combo> <prompt> <out>
  tersio settings --caveman-default "$1" --ponytail-default "$2" \
                  --rtk-default "$3" --combo-default "$4"
  /usr/bin/time -f '%e' -o "$6.time" \
    <host> -p --session-dir "$BENCH_TMP/$6" --no-tools \
      --model "<model>" "$5" > "$6.out"
}
run off off off off "$P1" base-p1      # base: all four off
run ultra off off off "$P1" cav-ultra-p1
```

If `tersio settings --help` does not accept level values, adapt the flags.

- One process per sample. Never reuse a session; hosts append to it.
- N = 5 per mode per prompt. Report median, min, and max.
- Fix the model, thinking level, and temperature, and record them. Free-tier models can ignore `--thinking`.
- Interleave modes (base, A, B, base, A, B...) to spread provider drift.
- Discard nothing; report cold-start outliers.

**Overhead gate.** Per mode, compare the tokenizer count of the injected block
(`<host> toks "<block>" --json`, `o200k_base`) with `contextSnapshot.nonMessageTokens` minus the
base. They must match within 5%; if not, the mode did not load — fix this before trusting any number.
Where the host records no `nonMessageTokens`, use the tokenizer count only, and say so.

### The overhead each host adds, from what it actually loads

Every host reads the rule bodies from a different place, and none of them is the repo's source copy:
omp runs the plugin package's `dist/extensions`, pi its `~/.pi/agent/extensions`, OpenCode its
`~/.config/opencode/plugins/tersio`. So the block a host pays is only known once you count the copy
it loads. `tersio doctor` reports any host whose copy differs from the repo's.

Measured on 2026-10-13 with `omp toks`, `o200k_base`:

| Host | `full` (`rule.md`) | `ultra` (`rule-ultra.md`) | `megacave` (`rule-megacave.md`) |
|---|---:|---:|---:|
| **repo (source of truth)** | 1,158 | 608 | 764 |
| omp | 1,346 | 558 | 714 |
| pi | 1,346 | 608 | 764 |
| OpenCode | 1,346 | 558 | 714 |

Only `pi/ultra` and `pi/megacave` matched the repo at the time of the run; every other cell was a
stale body. `full` costs the most and therefore pays back the slowest, which is the same conclusion
the reply-text table below reaches from the other direction. Run `tersio doctor`, then
`tersio install --host <host>`, and re-measure.

## 5. Reading the numbers

- `Block` = tokens the mode adds to the prompt; base is 0.
- `Token Δ` = median reply tokens − base median, same prompt and surface. Negative is a saving.
- `Net Δ` = `Block` + `Token Δ`, the first-turn effect. Negative means the mode already wins.

Use `usage.input`, `usage.output`, `usage.cacheRead`, `usage.cacheWrite`. In the sample record
`totalTokens` = `input + output + cacheRead`, so do not add `reasoning` twice. Confirm on your host.

## 6. Quality gates

A saving is valid only if the answer is still right. A mode that drops edge cases is not a saving.

**Code (C1–C3).** Save each reply's code, then check:

1. `tsc --strict --noEmit` passes.
2. A fixed test file passes. For C1: empty array, size larger than length, remainder chunk,
   `size <= 0` throws, and `chunkLazy` gives the same chunks as `chunk`.
3. Both requested functions exist.

**Prose (P1–P3).**

1. Exactly three sentences. Caveman fragments count as sentences only if you decide so before the
   run; write the rule down.
2. A fixed keyword list per prompt is present (for P1: reuse, connection, overhead/cost,
   concurrency/wait).
3. For `megacave-*` modes, score by keyword meaning, not string match.

**Agentic (A).** Pass = the suite is green and no test file was edited. Run base, `rtk on`,
`ponytail ultra`, and `combo medium`, N = 5. Report the pass rate beside every token and time number;
a failed run is reported, not dropped.

Report `Quality` (pass count out of N) beside every saving. Do not publish a saving for a mode that
fails more often than base.

## 7. RTK command set

RTK saving depends on how noisy the command is, so measure all groups and put each command in the
group its output belongs to. Run each plain, then through RTK; N = 5, median; record tokens and time.

**Compressible (large raw output)**

```bash
bun run test                  # rtk test bun run test
find . -name '*.test.ts'      # rtk find . -name '*.test.ts'
ls -la .                      # rtk ls -la .
git status                    # rtk git status
```

**Small (expect little or no gain)**

```bash
bun run build
find extensions -name '*.ts'
rtk deps
git diff --stat HEAD
git status --short
```

**Exact (output must be byte-identical)**

```bash
cat extensions/shared/rtk-gain.ts      # rtk read ...
grep -rn normalizeMode extensions      # rtk grep ...
git log --oneline -n 30
```

**Fidelity (required).** Savings on a passing suite prove little. On the failing-test fixture:

1. `bun run test` plain and through RTK. The failing test name, the assertion message, and the file
   and line must survive. Use the runner-native filter when one exists (`rtk bun test` for bun; the
   generic `rtk test <cmd>` wrapper truncates to a tail and fails this check).
2. The exit code is the same in both.
3. `stderr` content is kept.
4. `tsc --noEmit` on a file with one type error; the error must survive.
5. `tsc --noEmit` on a clean file; report any added tokens.

If a fidelity check fails, report a bug and do not publish the saving.

**End to end.** Run the agentic task (section 6) with `rtk` off and on. Savings that cause extra
steps or a failed task are not savings.

### Why the transcript shows no `rtk_run`

`rtk.ts` rewrites the `command` field of `bash` calls in a `tool_call` hook, and the host writes the
transcript before the hook runs: the file shows `ls -la`; RTK ran `rtk ls -la`. To prove RTK ran,
look for `... (N earlier lines, ctrl+o to expand)` in the output.

## 8. Traps

- **Saved defaults.** Set all four to `off` before the base run.
- **Prompt on one surface only.** Code replies are longer than prose replies; use a separate base per surface.
- **Combo without tools.** With `--no-tools` the RTK part does nothing but its block still costs tokens, so the result measures only Caveman + Ponytail. Label it so.
- **Combo sums.** Check that the Combo `Block` equals the sum of its parts; if not, find the extra tokens (wrapper text?) and report them.
- **Synthetic base prompt.** A 14-token base prompt hides the host's own overhead (about 13.8k tokens in the sample record). Say which base you used, and report `Block` as a share of the real `nonMessageTokens`.
- **Cache.** `Tokens` includes `cacheRead`, so a cached run and an uncached run are not comparable.
- **One model.** Run the full sweep on one more model; mode savings often differ by model.
- **Model availability.** A 403 is a provider limit, not a broken mode. Record which host and model produced which number.

## 9. Reporting

Put the summary table first.

```markdown
| Mode | Surface | Block | Token Δ | Net Δ | Quality | Tokens | Time |
|---|---|---:|---:|---:|---:|---:|---:|
| `off` (base) | prose | 0 | 0 | 0 | 5/5 | … | 0:52 |
```

Then one table per mode family with a verdict line under each, same column names. For RTK:
`Tool call | Base | After | Δ | Δ% | Δ time | Fidelity`.

Verdicts name the failure cases too. Write "strongest in this sample", never "saves 63%".

End with the environment line:

```markdown
Rerun on YYYY-MM-DD using Bun X, host Y, model Z (thinking T, temperature K), Tersio A, RTK B, Ponytail C, tokenizer o200k_base, N = 5.
```

Add your run newest first; do not overwrite old numbers. If you change the protocol, say which
numbers are no longer comparable.

A prompt-overhead run is a valid run on its own and needs no model calls: count the block each host
loads and report it per host, because the copy a host reads is not the repo's copy.

### Recorded run: prompt overhead, per host

```markdown
Rerun on 2026-10-13 using Bun 1.4.3, hosts omp 18.8.7 + pi 1.1.0 + opencode, model n/a (no model
call), Tersio 2.25.5, RTK 0.51.0, Ponytail 5.1.0, tokenizer o200k_base, N = 1 (deterministic
offline count).
```

| Host | `full` | `ultra` | `megacave` | Verdict |
|---|---:|---:|---:|---|
| repo | 1,158 | 608 | 764 | source of truth |
| omp | 1,346 | 558 | 714 | all three stale |
| pi | 1,346 | 608 | 764 | `full` stale |
| OpenCode | 1,346 | 558 | 714 | all three stale |

`tersio doctor` now reports each host whose copy differs from the repo's, so this table can be
re-derived without counting by hand.

## 10. Done checklist

- [ ] `doctor` passed; overhead check within 5% for every mode
- [ ] Base for prose, code, and agentic
- [ ] Every mode and level in section 3, on both surfaces
- [ ] N = 5, median with min and max, three prompts per surface
- [ ] Quality score beside every saving
- [ ] RTK: three groups, fidelity checks, end-to-end run
- [ ] Token and time reported
- [ ] Environment line complete
- [ ] Working tree unchanged; `TERSIO_HOME` pointed at `$BENCH_TMP`; sessions only in `$BENCH_TMP`
