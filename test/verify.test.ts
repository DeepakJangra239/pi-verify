/**
 * Regression tests for pi-verify's join-surface detectors.
 *
 * Run: npm install && npm test — or `node --experimental-strip-types test/verify.test.ts`
 *
 * Every detector is tested twice: once on a fixture where it must fire, and —
 * more importantly — on a clean twin where it must stay silent. A detector that
 * fires on everything is worse than no detector, so the negative cases are the
 * ones that carry the weight here.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const { buildReport, mergeBase } = await import("../verify.ts");

let failed = 0;
function check(label: string, ok: boolean, detail: string): void {
	if (ok) console.log(`ok — ${label}`);
	else {
		failed += 1;
		console.error(`fail — ${label}`);
		console.error(`  ${detail}`);
	}
}

const roots: string[] = [];
function makeRepo(name: string, files: Record<string, string>, feature: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), `pi-verify-${name}-`));
	roots.push(root);
	const g = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	const write = (rel: string, body: string) => {
		const abs = join(root, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, body);
	};
	for (const [p, b] of Object.entries(files)) write(p, b);
	g("init", "-q", "-b", "main");
	g("add", "-A");
	g("-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "base");
	g("checkout", "-qb", "feature");
	for (const [p, b] of Object.entries(feature)) write(p, b);
	g("add", "-A");
	// --allow-empty: the "no changes" fixture writes identical content and has nothing to commit.
	g("-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "work");
	return root;
}

// ── Degradation: not a repository at all ─────────────────────────────────────
{
	const plain = mkdtempSync(join(tmpdir(), "pi-verify-plain-"));
	roots.push(plain);
	const r = buildReport(plain);
	check("degrades to an empty report outside a repository", r.degraded === true && r.findings.length === 0 && mergeBase(plain) === "", JSON.stringify(r.findings));
}

// ── Delivery path: a new migration no manifest delivers ───────────────────────
{
	const dirty = makeRepo(
		"dirty",
		{ "deploy.manifest": "migrations_shipped.txt\n", "src/keep.py": "VALUE = 1\n" },
		{ "migrations/999_orphan.sql": "x = 1;\n" },
	);
	const r = buildReport(dirty);
	check("flags a new file no manifest delivers", r.manifestGaps.includes("migrations/999_orphan.sql"), JSON.stringify(r.manifestGaps));
	check("flags the same file as referenced by nothing", r.unreferencedFiles.includes("migrations/999_orphan.sql"), JSON.stringify(r.unreferencedFiles));
	check("finds the manifest gap", r.findings.some((f) => f.kind === "manifest_gap" && f.subject.includes("999_orphan")), JSON.stringify(r.findings.map((f) => f.kind)));

	// Negative control: the identical repo, but the manifest lists the migration.
	const clean = makeRepo(
		"clean-manifest",
		{ "deploy.manifest": "migrations_shipped.txt\n", "src/keep.py": "VALUE = 1\n" },
		{ "deploy.manifest": "migrations_shipped.txt\nmigrations/099_added.sql\n", "migrations/099_added.sql": "x = 1;\n" },
	);
	const c = buildReport(clean);
	check("NEGATIVE: no manifest gap when the manifest lists the new file", !c.manifestGaps.includes("migrations/099_added.sql"), JSON.stringify(c.manifestGaps));
}

// ── Schedules: an entry pointing at an absent script ──────────────────────────
{
	const broken = makeRepo(
		"sched",
		{ "crontab": "0 6 * * 1-5 $SCRIPTS/run_daily.sh ALL\n" },
		{ "src/keep.py": "VALUE = 2\n" },
	);
	const r = buildReport(broken);
	check("flags a scheduled script that does not exist", r.brokenSchedules.length === 1 && r.brokenSchedules[0]!.includes("run_daily.sh"), JSON.stringify(r.brokenSchedules));

	const fixed = makeRepo(
		"sched-ok",
		{ "crontab": "0 6 * * 1-5 $SCRIPTS/run_daily.sh ALL\n" },
		{ "scripts/run_daily.sh": "#!/bin/sh\necho hi\n", "src/keep.py": "VALUE = 2\n" },
	);
	const c = buildReport(fixed);
	check("NEGATIVE: no broken schedule once the script exists", c.brokenSchedules.length === 0, JSON.stringify(c.brokenSchedules));
}

// ── Dependencies: declared, never imported ───────────────────────────────────
{
	const dep = makeRepo(
		"dep",
		{ "requirements.txt": "fastapi\n", "src/keep.py": "import fastapi\n" },
		{ "requirements.txt": "fastapi\nhttpx\n", "src/app.py": "import fastapi\n" },
	);
	const r = buildReport(dep);
	check("flags a dependency no changed code imports", r.unreferencedDependencies.some((d) => d.startsWith("httpx")), JSON.stringify(r.unreferencedDependencies));
	check("does not flag the dependency that is imported", !r.unreferencedDependencies.some((d) => d.startsWith("fastapi")), JSON.stringify(r.unreferencedDependencies));
	check("a declared dep does not satisfy its own import check", r.unreferencedDependencies.some((d) => d.startsWith("fastapi")) === false && r.unreferencedDependencies.length === 1, JSON.stringify(r.unreferencedDependencies));
}

// ── Join symbols: a changed file's symbol now called elsewhere ───────────────
{
	const j = makeRepo(
		"join",
		{ "src/old.py": "def helper():\n    return 1\n" },
		{ "src/old.py": "def helper():\n    return 2\n", "src/caller.py": "from .old import helper\n\ndef go():\n    return helper()\n" },
	);
	const r = buildReport(j);
	const found = r.joinSymbols.some((s) => s.symbol === "helper" && s.file === "src/old.py" && s.callers.includes("src/caller.py"));
	// The definition line did not move; only the body did. Restricting to added lines misses this.
	check("finds a join whose definition line is unchanged context", found, JSON.stringify(r.joinSymbols));

	const solo = makeRepo("solo", { "src/old.py": "def helper():\n    return 1\n" }, { "src/old.py": "def helper():\n    return 9\n" });
	check("NEGATIVE: no join symbol when nothing else calls it", buildReport(solo).joinSymbols.length === 0, JSON.stringify(buildReport(solo).joinSymbols));
}

// ── Reporting is never fatal ─────────────────────────────────────────────────
{
	const dirty = makeRepo(
		"report",
		{ "deploy.manifest": "x\n" },
		{ "migrations/aaa.sql": "x=1;\n" },
	);
	const r = buildReport(dirty);
	check("every finding carries a kind and a detail", r.findings.every((f) => !!f.kind && !!f.subject && !!f.detail), JSON.stringify(r.findings));
	check("reports honestly when a repo has no changes", (() => {
		const q = makeRepo("nochange", { "a.py": "x = 1\n" }, { "a.py": "x = 1\n" });
		const rr = buildReport(q);
		return rr.degraded === false && rr.findings.length === 0;
	})(), "");
}


// ── False positives found on a real 38-file branch ───────────────────────────
// Each case below is a false positive the first version produced against the actual repo.
// Every one is paired with a NEGATIVE control, because a detector that fires on everything is
// worse than no detector — and the original controls missed these precisely by using fixtures
// with no second definition and no docs.

const { isDeployableArtifact } = await import("../verify.ts");

// --- manifest / unreferenced scoping: tests and docs are not deployable artefacts ---
{
	const dirty = makeRepo(
		"artefacts",
		{ "deploy.manifest": "migrations_shipped.txt\n" },
		{
			"migrations/003_real.sql": "x=1;\n",
			"tests/test_thing.py": "x=1\n",
			"docs/notes.md": "# hi\n",
			"README.md": "hi\n",
			".github/workflows/ci.yml": "on: push\n",
			"conftest.py": "x=1\n",
		},
	);
	const r = buildReport(dirty);
	check("a new migration IS still flagged as a manifest gap", r.manifestGaps.includes("migrations/003_real.sql"), JSON.stringify(r.manifestGaps));
	check(
		"NEGATIVE: tests, docs, README, CI config and conftest are never manifest gaps",
		!r.manifestGaps.some((f) => /^(tests\/|docs\/|\.github\/)/.test(f) || /README\.md$|conftest\.py$/.test(f)),
		JSON.stringify(r.manifestGaps),
	);
	check(
		"NEGATIVE: an empty report beats 12 false positives",
		r.manifestGaps.length === 1,
		`${r.manifestGaps.length} gaps: ${r.manifestGaps.join(", ")}`,
	);
	check(
		"unreferenced_file uses the same scoping",
		!r.unreferencedFiles.some((f) => f.startsWith("tests/") || f.startsWith("docs/")),
		JSON.stringify(r.unreferencedFiles),
	);
	// Direct unit check on the predicate.
	check("isDeployableArtifact rejects tests/ and docs/", !isDeployableArtifact("tests/test_x.py") && !isDeployableArtifact("docs/a.md"), "");
	check("isDeployableArtifact accepts migrations/ and .sql", isDeployableArtifact("migrations/003_x.sql"), "");
}

// --- schedule targets: an absolute host path is not a repo path ---
{
	const hostPath = makeRepo(
		"hostpath",
		{ "app/service.py": "x=1\n" },
		{
			"scripts/thing.service": "[Service]\nExecStart=/home/deep/deploy/venv/bin/python -m thing\n",
			"cron/crontab": "0 4 * * * $SCRIPTS/missing.sh\n",
		},
	);
	const r = buildReport(hostPath);
	check(
		"NEGATIVE: an absolute ExecStart path is not reported as missing",
		!r.brokenSchedules.some((b) => b.includes("/home/")),
		JSON.stringify(r.brokenSchedules),
	);
	check("a genuinely missing repo-relative script IS still flagged", r.brokenSchedules.some((b) => b.includes("missing.sh")), JSON.stringify(r.brokenSchedules));
}

// --- external_callers: a definition is not a call ---
// Reproduced exactly: four migrate_*.py files each define run_migration. The first version
// counted the other three definitions as callers and invented a join that did not exist.
{
	const defs = makeRepo(
		"defs",
		{ "a.py": "def helper():\n    return 1\n" },
		{
			"a.py": "def helper():\n    return 2\n",
			"b.py": "def helper():\n    return 3\n",
			"c.py": "def helper():\n    return 4\n",
		},
	);
	const r = buildReport(defs);
	check(
		"NEGATIVE: sibling definitions are not callers",
		!r.joinSymbols.some((j) => j.symbol === "helper"),
		JSON.stringify(r.joinSymbols),
	);
	check("NEGATIVE: and produce no external_callers finding", !r.findings.some((f) => f.kind === "external_callers"), JSON.stringify(r.findings));

	// Shadowing AND importing the definer is a genuine caller — do not over-correct.
	const shadow = makeRepo(
		"shadow",
		{ "lib.py": "def helper():\n    return 1\n" },
		{
			"lib.py": "def helper():\n    return 2\n",
			"mid.py": "def helper():\n    return 3\nfrom lib import helper as _h\n\nprint(_h())\n",
		},
	);
	const sh = buildReport(shadow);
	check(
		"a shadowing file that also imports the definer IS a caller",
		sh.joinSymbols.some((j) => j.symbol === "helper" && j.callers.includes("mid.py")),
		JSON.stringify(sh.joinSymbols),
	);

	// Positive control: a real call must still be found.
	const called = makeRepo(
		"called",
		{ "a.py": "def helper():\n    return 1\n" },
		{ "a.py": "def helper():\n    return 2\n", "b.py": "from a import helper\n\nprint(helper())\n" },
	);
	const c = buildReport(called);
	check("a genuine call is still reported", c.joinSymbols.some((j) => j.symbol === "helper" && j.callers.includes("b.py")), JSON.stringify(c.joinSymbols));
}

// --- external_callers: docs are not callers, and dunders are not joins ---
{
	const docsy = makeRepo(
		"docsy",
		{ "a.py": "def helper():\n    return 1\n" },
		{
			"a.py": "def helper():\n    return 2\n",
			"b.py": "from a import helper\n\nprint(helper())\n",
			"README.md": "see helper for details\n",
			"data.json": "{\"helper\": 1}\n",
		},
	);
	const r = buildReport(docsy);
	const j = r.joinSymbols.find((x) => x.symbol === "helper");
	check("a real caller is found", !!j && j.callers.includes("b.py"), JSON.stringify(r.joinSymbols));
	check(
		"NEGATIVE: README.md and data.json are not callers",
		!!j && !j.callers.some((c) => !/\.(py|ts|js|go|rs|rb|java|kt|cs|php|sh)$/i.test(c)),
		JSON.stringify(j?.callers),
	);

	const dunder = makeRepo(
		"dunder",
		{ "pkg/__init__.py": "VALUE = 1\n" },
		{ "pkg/__init__.py": "VALUE = 2\n", "other.py": "import pkg  # __init__ runs\n" },
	);
	const d = buildReport(dunder);
	check("NEGATIVE: __init__ is not reported as a join", !d.joinSymbols.some((x) => x.symbol === "__init__"), JSON.stringify(d.joinSymbols));
}

// ── Anchor scope: worktree, untracked, and baselines ──────────────────────────
// The scope must cover what the goal did however it was written: committed or
// not, on one commit or five, via edit tools or by hand. Branch-only diffs miss
// all of that, so these fixtures exercise the union directly.
function uncommitted(root: string, files: Record<string, string>): void {
	const g = (abs: string) => mkdirSync(join(abs, ".."), { recursive: true });
	for (const [p, b] of Object.entries(files)) {
		const abs = join(root, p);
		g(abs);
		writeFileSync(abs, b);
	}
}

{
	const wt = makeRepo("worktree", { "src/a.py": "def f():\n    return 1\n" }, { "src/a.py": "def f():\n    return 2\n" });
	uncommitted(wt, { "src/b.py": "def g():\n    return 3\n" });
	const r = buildReport(wt);
	check("an uncommitted new file is in scope", r.addedFiles.includes("src/b.py"), JSON.stringify(r.addedFiles));
	check("an uncommitted new file is a changed file", r.changedFiles.some((c) => c.file === "src/b.py"), JSON.stringify(r.changedFiles.map((c) => c.file)));
	check("scope is not degraded on worktree content", r.degraded === false, String(r.degraded));
}

{
	// Two commits on one branch: the goal baseline isolates the goal's own work.
	const root = makeRepo("baseline", { "src/a.py": "def f():\n    return 1\n" }, { "src/other.py": "def o():\n    return 1\n" });
	const shaA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	uncommitted(root, { "src/goal.py": "def g():\n    return 1\n" });
	execFileSync("git", ["add", "-A"], { cwd: root });
	execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "goal-work"], { cwd: root });
	const anchored = buildReport(root, shaA);
	const files = anchored.changedFiles.map((c) => c.file);
	check("baseline scope holds the goal commit", files.includes("src/goal.py"), JSON.stringify(files));
	check("baseline scope excludes pre-goal commits", !files.includes("src/other.py"), JSON.stringify(files));
	check("baseline scope kind is baseline", anchored.scope.kind === "baseline", anchored.scope.range);
	const whole = buildReport(root);
	check("branch fallback still sees the whole branch", whole.changedFiles.some((c) => c.file === "src/other.py"), JSON.stringify(whole.changedFiles.map((c) => c.file)));
}

// ── Precision: generic names, non-shipped roles, shape gating ────────────────
{
	// JS locals and generic exports referenced without an import edge are noise.
	const js = makeRepo(
		"genericjs",
		{ "a.js": "export const widget = 1;\n" },
		{
			"a.js": "export const widget = 2;\nexport const data = 1;\n",
			"b.js": "const data = 1;\nconsole.log(data, status, main);\n",
		},
	);
	const r = buildReport(js);
	check(
		"NEGATIVE: generic names without an import edge are not joins",
		!r.joinSymbols.some((j) => ["data", "status", "main"].includes(j.symbol)),
		JSON.stringify(r.joinSymbols),
	);
	check("NEGATIVE: and produce no external_callers findings", !r.findings.some((f) => f.kind === "external_callers"), JSON.stringify(r.findings));

	const js2 = makeRepo(
		"jsimport",
		{ "a.js": "export const widget = 1;\n" },
		{
			"a.js": "export const widget = 2;\n",
			"c.js": "import { widget } from \"./a\";\nconsole.log(widget);\n",
		},
	);
	const c2 = buildReport(js2);
	check("an importing caller is still reported", c2.joinSymbols.some((j) => j.symbol === "widget" && j.callers.includes("c.js")), JSON.stringify(c2.joinSymbols));
}

{
	// Non-shipped roles are withheld by role, not by hardcoded directory names.
	const ev = makeRepo(
		"nonshipped",
		{ "notes/evidence/h.py": "def run_all():\n    return 1\n" },
		{
			"notes/evidence/h.py": "def run_all():\n    return 2\n",
			"checks/t_caller.py": "from h import run_all\n\nprint(run_all())\n",
		},
	);
	const r = buildReport(ev);
	check("non-shipped definers are withheld, not reported", r.withheldNonShipped > 0 && !r.findings.some((f) => f.kind === "external_callers"), JSON.stringify({ w: r.withheldNonShipped, f: r.findings }));
}

{
	// A repo with no manifests or schedules says so in one line — via shape flags.
	const lib = makeRepo("libshape", { "src/a.py": "def f():\n    return 1\n" }, { "src/a.py": "def f():\n    return 2\n" });
	const r = buildReport(lib);
	check("ops detectors stay silent on a library-shaped repo", r.shape.hasManifests === false && r.shape.hasSchedules === false && r.manifestGaps.length === 0 && r.brokenSchedules.length === 0, JSON.stringify(r.shape));
}

{
	// A manifest that ships a directory covers new files inside it (fonts-class risk).
	const covered = makeRepo(
		"manifestdir",
		{ "deploy.manifest": "scripts/\n", "scripts/old.sh": "echo old\n" },
		{ "scripts/new.sh": "echo new\n" },
	);
	const r = buildReport(covered);
	check("NEGATIVE: no manifest gap when the manifest ships the directory", !r.manifestGaps.includes("scripts/new.sh"), JSON.stringify(r.manifestGaps));

	const bare = makeRepo(
		"manifestbare",
		{ "deploy.manifest": "other/\n", "scripts/old.sh": "echo old\n" },
		{ "scripts/new.sh": "echo new\n" },
	);
	const rb = buildReport(bare);
	check("a manifest gap still fires when nothing covers the file", rb.manifestGaps.includes("scripts/new.sh"), JSON.stringify(rb.manifestGaps));
}

{
	// Dependencies beyond requirements.txt / package.json.
	const g = makeRepo(
		"gomod",
		{ "go.mod": "module example.com/m\n\ngo 1.21\n", "main.go": "package main\n" },
		{ "go.mod": "module example.com/m\n\ngo 1.21\n\nrequire example.com/foo v1.0.0\n" },
	);
	const r = buildReport(g);
	check("a go.mod dependency imported nowhere is flagged", r.unreferencedDependencies.some((d) => d.startsWith("example.com/foo")), JSON.stringify(r.unreferencedDependencies));
}

for (const r of roots) rmSync(r, { recursive: true, force: true });

if (failed > 0) {
	console.error(`\n${failed} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");