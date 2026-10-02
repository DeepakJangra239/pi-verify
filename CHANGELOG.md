# Changelog

Notable changes to this extension. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/) and are tagged `vX.Y.Z`.

Pinned installs are not moved by `pi update --extensions`. Upgrade deliberately:

```bash
pi install git:github.com/DeepakJangra239/pi-verify@vX.Y.Z
```

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