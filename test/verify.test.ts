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

for (const r of roots) rmSync(r, { recursive: true, force: true });

if (failed > 0) {
	console.error(`\n${failed} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");