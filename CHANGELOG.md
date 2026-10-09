# Changelog

Notable changes to this extension. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) and are tagged `vX.Y.Z`.

Pinned installs are not moved by `pi update --extensions`. Upgrade deliberately:

```bash
pi install git:github.com/DeepakJangra239/pi-verify@vX.Y.Z
```

## [Unreleased]

### Changed

- **Anchored scope.** `buildReport(cwd, baselineHead?)` unions committed-since-baseline + staged/unstaged worktree + untracked files; falls back to merge-base, then worktree-only, then degraded. Reports carry `scope` metadata (kind, range, untracked count, truncation) so staleness is checkable.
- **Precision.** Join symbols are exports-only (Python top-level def/class; JS/TS `export` forms), callers require an import/require edge, generic names (`data`, `status`, `main`, …) are suppressed, and non-shipped roles (tests, docs, evidence, fixtures — matched generically, overridable via `verify.json`) are withheld and counted, not reported. Ranked (introduced-first, caller count) and capped at 15 with withheld counts.
- **Shape gating.** Manifest/schedule detectors run only when the repo shows that shape; otherwise one "not applicable" line. Manifest coverage understands ancestor directories (a manifest shipping `static/` covers new fonts inside it). Dependencies extended to `go.mod`, `Cargo.toml`, `pyproject.toml`, `Gemfile`.
- `verify_joins` is now documented as an on-demand diagnostic (optional `baselineHead` param), not a mandatory review pre-pass.

## [0.1.1] - 2026-10-03

Fixes false positives found by running this against a real 38-file branch, where 12 of the
reported items were noise. A detector that cries wolf trains the reader to skim past it, so each
fix below is paired with a negative control.

### Fixed

- **Tests, docs, CI config and `conftest.py` were reported as manifest gaps.** They are never
  meant to ship, so their absence from a manifest is not a question. `isDeployableArtifact` now
  scopes both `manifest_gap` and `unreferenced_file` to things plausibly delivered.
- **An absolute `ExecStart=` path was reported as a missing scheduled script.** `/home/.../venv/bin/python`
  refers to the machine the unit runs on, not this checkout, so "not present here" was meaningless.
  Only repo-relative targets are checked.
- **A definition was counted as a call.** Four `migrate_*.py` files each *define* `run_migration`
  and each call their own; the grep counted the three sibling definitions as callers and invented a
  join. A file that defines the same name now counts only if it also imports the defining module.
- **Docs and data files were listed as callers**, and `__init__` was reported as a join surface.
  `CALLABLE_EXT` is now narrower than the indexing set, and dunders are skipped.

### Changed

- **`external_callers` is a finding only when the branch introduced the symbol.** On a branch that
  rewrites a module nearly every symbol in it is "touched"; reporting them all turned 38 changed
  files into 68 findings. Everything else remains in `joinSymbols` as context. Findings on that
  branch: 68 -> 47, and now all true.

## [0.1.0] - 2026-10-02

### Added
- **`verify_joins` tool and `/verify` command.** Inventories the join surface of the branch under review: new files nothing in the repo references, new files no manifest delivers, schedules pointing at absent scripts, dependencies no changed code imports, and symbols this branch's changed files define that other files already call. Docks into `pi-sidebar` as a section when the host is present.
- **Reports, never fails.** There is no blocking path: the tool always returns. Enforcement belongs to `pi-goal`'s verification gate, which can actually refuse.

### Notes
- Every detector has a **negative control** in `test/verify.test.ts` — a clean twin fixture it must stay silent on. A detector that fires on everything is worse than none.
- `mergeBase` selects the candidate ref yielding the **smallest** diff rather than the first that exists. Repositories whose branches fork from `development` were otherwise diffed against `main`, dragging in unrelated history.
- Manifest discovery matches on **file name**, not extension. An extension filter was silently excluding `deploy.manifest` — precisely the file the manifest-gap check exists to consult.
- The dependency check excludes the declaring files from its own import corpus. Including `requirements.txt` made every declared dependency satisfy its own check, so nothing added on a branch could ever be flagged.
- `external_callers` reads each changed file's **current** content rather than only its added lines, so a join is still found when the definition line is unchanged context.
- Outside a git repository the report is empty and marked `degraded`; nothing throws.