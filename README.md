# pi-verify

Join-surface inventory for a branch under review, for [pi](https://pi.dev).

## Why

The defects worth finding are almost never inside one function. They are **joins**:

- a documented tolerance ("best-effort", "proceeds without") that holds at one call site and not the next
- a cron entry that fires before the precondition it assumes
- an artifact that exists but never joins the delivery path
- a negative cache that nothing can invalidate

Every piece is individually correct, so reading any one of them proves nothing. This extension does not review code and does not judge it — it makes the join surface **visible**, so a review spends its attention where the risk is instead of rediscovering the topology.

It **reports; it never fails.** A noisy detector that blocks is worse than no detector. Enforcement lives in [`pi-goal`](https://github.com/DeepakJangra239/pi-goal)'s verification gate.

## Install

```bash
pi install git:github.com/DeepakJangra239/pi-verify@v0.1.0      # pinned
```

Docks into [`pi-sidebar`](https://github.com/DeepakJangra239/pi-sidebar) as a section when present.

## Usage

- `/verify` — this review scope's join surface (anchored at the goal baseline when given)
- `verify_joins` — the same, as an on-demand diagnostic tool. Takes an optional `baselineHead` (the goal anchor) to scope committed-since-baseline + worktree + untracked instead of the whole branch diff.

## Scope

Anchored, not branch-wide. With a baseline the report unions committed-since-baseline, staged/unstaged worktree, and untracked files; without one it falls back to the merge-base diff, then to a degraded empty report. Every report states the range it covered (`scope.range`), so staleness is checkable.

## Config (`verify.json`)

Non-shipped roles (tests, docs, evidence, fixtures) are matched generically by path role, never by hardcoded directory names. Extend or override in `<repo>/.pi/verify.json` (or the global agent dir):

```json
{ "excludeRoles": ["(^|/)my-notes?(/|$)"], "includePaths": ["docs/api"] }
```

## What it looks for

| Finding | Meaning |
|---|---|
| `unreferenced_file` | added on this branch, referenced by nothing else in the repo |
| `manifest_gap` | added, but no manifest appears to deliver it — is it actually shipped? |
| `missing_schedule_target` | a cron/systemd/CI entry points at a script that is not there |
| `unreferenced_dependency` | declared in `requirements.txt`/`package.json`, imported by no changed code |
| `external_callers` | a symbol this branch's changed files define that other files already call |

`external_callers` reads each changed file's **current** content, not only its added lines: the join that matters is often a symbol whose definition did not move but whose file now sits on a new call path.

## Independence

`pi-verify` shares no code, no state and no config with `pi-goal`. `/goal off` therefore breaks nothing here — `verify_joins` and `/verify` keep working, which is useful because turning goal off also removes its verification receipt gate, leaving this as the only mechanical floor.

## Honesty properties

These are deliberate, and each has a test that would fail if it regressed:

- **Negative controls.** Every detector is tested on a clean twin fixture and must stay silent. A detector that fires on everything scores nothing.
- **Degrades, never throws.** Outside a git repository, or with no reachable merge base, it returns an empty report marked `degraded`. It never blocks on a repository it cannot read.
- **Merge base by smallest diff.** It picks the candidate ref whose branch point yields the least change, not the first ref that exists — otherwise a repo whose branches fork from `development` gets diffed against `main` and every file saturates.
- **Findings are questions.** Output says explicitly that a finding is not a verdict: an unreferenced new file may be legitimately standalone, and a broken schedule may be a template.
- **Skips vendored trees.** `node_modules`, `venv`, `dist`, `__pycache__` and friends are not walked, and files over 512 KB are not indexed.

## Configuration

None. It is read-only and never writes to your repository.

## Layout

- `verify.ts` — extension source: `verify_joins` tool, `/verify` command, sidebar section
- `test/verify.test.ts` — detector tests, each paired with a negative control

## Development

```bash
npm install && npm test      # node --experimental-strip-types test/verify.test.ts
```

## License

MIT