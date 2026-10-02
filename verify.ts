/**
 * verify — join-surface inventory for a branch under review, for pi.
 *
 * Why this exists
 * ---------------
 * The defects worth finding are almost never inside one function. They are joins:
 * a documented tolerance that holds at one call site but not the next; a cron
 * entry that fires before the precondition it assumes; an artifact that exists but
 * never joins the delivery path; a negative cache nothing can invalidate. Each
 * piece is individually correct, so reading any one of them proves nothing.
 *
 * This extension does not review code and does not judge it. It makes the joins
 * *visible* — the cross-file surface a change just created — so a reviewer spends
 * its attention where the risk actually is instead of rediscovering the topology.
 *
 * It deliberately reports rather than fails. A noisy detector that blocks is worse
 * than no detector, and the enforcement lives in pi-goal's verification gate.
 *
 * Model-facing surface:
 *   - `verify_joins` — inventory of the branch's join surface, plus risk ranking
 *
 * Human-facing surface:
 *   - `/verify` — same, as a sidebar section when pi-sidebar is present
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve as pathResolve, basename, extname } from "node:path";
import { execFileSync } from "node:child_process";

const SKIP_DIRS = new Set([
	".git", "node_modules", "venv", ".venv", "__pycache__", "dist", "build", "target",
	".next", ".nuxt", "vendor", "coverage", ".pytest_cache", ".mypy_cache", ".tox", ".idea", ".vscode",
]);

/** Files that describe how something gets delivered. A new file absent from these is a question. */
const MANIFEST_HINTS = [
	"manifest", "dockerfile", "package.json", "setup.py", "setup.cfg", "pyproject.toml",
	"makefile", "justfile", "build.gradle", "cargo.toml", "go.mod", ".csproj", "gemfile",
	"buildspec.yml", "cloudbuild.yaml", "deploy", "install",
];

export type FindingKind =
	| "unreferenced_file"
	| "manifest_gap"
	| "missing_schedule_target"
	| "external_callers"
	| "unreferenced_dependency";

export interface Finding {
	kind: FindingKind;
	subject: string;
	detail: string;
}

export interface ChangedFile {
	file: string;
	added: number;
	removed: number;
	binary: boolean;
}

export interface JoinReport {
	repo: string;
	base: string;
	changedFiles: ChangedFile[];
	addedFiles: string[];
	/** New files nothing else in the repo mentions. */
	unreferencedFiles: string[];
	/** New files that no manifest-like file appears to cover. */
	manifestGaps: string[];
	/** Scheduled entries whose target script does not exist. */
	brokenSchedules: string[];
	/** Symbols this branch newly exposes that other files already call. */
	joinSymbols: { file: string; symbol: string; callers: string[] }[];
	/** Dependency declarations nothing on the branch imports. */
	unreferencedDependencies: string[];
	findings: Finding[];
	/** True when nothing could be determined (not a repo, no base). */
	degraded: boolean;
}

function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim();
	} catch {
		return null;
	}
}

/** Merge-base with the candidate ref that yields the smallest diff. */
export function mergeBase(cwd: string): string {
	let best = "";
	let bestScore = Number.POSITIVE_INFINITY;
	const seen = new Set<string>();
	const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	for (const ref of [upstream, "main", "master", "develop", "development", "trunk"]) {
		if (!ref || seen.has(ref)) continue;
		seen.add(ref);
		const base = git(cwd, ["merge-base", "HEAD", ref]);
		if (!base || base === best) continue;
		const out = git(cwd, ["diff", "--numstat", `${base}...HEAD`]);
		if (out === null) continue;
		let total = 0;
		for (const line of out.split("\n")) {
			const parts = line.split("\t");
			const a = Number(parts[0]);
			const d = Number(parts[1]);
			if (Number.isFinite(a)) total += a;
			if (Number.isFinite(d)) total += d;
		}
		if (total < bestScore) {
			bestScore = total;
			best = base;
		}
	}
	return best;
}

export function changedFilesOf(cwd: string, base: string): ChangedFile[] {
	const out = git(cwd, ["diff", "--numstat", `${base}...HEAD`]);
	if (out === null) return [];
	const rows: ChangedFile[] = [];
	for (const line of out.split("\n")) {
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const file = parts[2]!.trim();
		const a = Number(parts[0]);
		const d = Number(parts[1]);
		// Git prints "-" for binary files; Number("-") is NaN, which is the signal.
		rows.push({ file, added: a, removed: d, binary: !Number.isFinite(a) || !Number.isFinite(d) });
	}
	return rows;
}

/** Repo files to search, skipping vendored and generated trees. */
function walk(root: string, out: string[] = [], depth = 0): string[] {
	if (depth > 12) return out;
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return out;
	}
	for (const name of entries) {
		if (SKIP_DIRS.has(name) || name.startsWith(".") && name !== ".") {
			if (SKIP_DIRS.has(name)) continue;
		}
		const abs = join(root, name);
		let st;
		try {
			st = statSync(abs);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			if (SKIP_DIRS.has(name)) continue;
			walk(abs, out, depth + 1);
		} else if (st.isFile()) {
			// Skip very large files; a 4MB bundle cannot hide a join in a useful way.
			if (st.size > 512 * 1024) continue;
			out.push(abs);
		}
	}
	return out;
}

const CODE_EXT = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java",
	".kt", ".cs", ".php", ".sh", ".bash", ".sql", ".yaml", ".yml", ".toml", ".json",
]);

/**
 * Extensions whose contents can actually *call* a symbol.
 *
 * Deliberately narrower than CODE_EXT: manifests and data fixtures are worth indexing, but a
 * JSON blob that mentions `helper` does not call it. Confusing the two produced callers like
 * `data.json` and `README.md` on a real branch.
 */
const CALLABLE_EXT = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java",
	".kt", ".cs", ".php", ".sh", ".bash",
]);

function readText(abs: string): string | null {
	try {
		return readFileSync(abs, "utf8");
	} catch {
		return null;
	}
}

/** Symbols a file's added lines newly define. */
function definedSymbols(addedText: string): string[] {
	const out = new Set<string>();
	const rx = /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:def|function|func|fn|class|struct|interface|type|enum|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
	for (const m of addedText.matchAll(rx)) out.add(m[1]!);
	return [...out];
}

/** Crontab / systemd / CI schedule entries and the paths they point at. */
function scheduleTargets(cwd: string, files: string[]): { entry: string; target: string }[] {
	const out: { entry: string; target: string }[] = [];
	const schedLike = (f: string) =>
		/(^|\/)(crontab|cron|.*\.timer|.*\.cron|.*\.service)$/i.test(f) ||
		/(\.github\/workflows\/.*\.ya?ml)$/i.test(f) ||
		/(^|\/)(crontab|.*\.cron)$/i.test(basename(f));
	for (const abs of files) {
		const rel = relative(cwd, abs);
		if (!schedLike(rel)) continue;
		const text = readText(abs);
		if (text === null) continue;
		for (const line of text.split("\n")) {
			// A cron line: m h dom mon dow <command>
			const m = line.match(/^\s*[\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+\s+(.+)$/);
			if (m) {
				for (const tok of (m[1] ?? "").split(/\s+/)) {
					if (tok.includes("/") && !tok.startsWith("-") && !tok.startsWith(">")) {
						out.push({ entry: `${rel}: ${line.trim().slice(0, 80)}`, target: tok.replace(/^["']|["']$/g, "") });
					}
				}
				continue;
			}
			// systemd: ExecStart=/path/to/script
			const e = line.match(/^\s*ExecStart=\+?\s*(\S+)/i);
			if (e) out.push({ entry: `${rel}: ${line.trim().slice(0, 80)}`, target: e[1]! });
		}
	}
	return out;
}

/** Dependency names declared by a manifest-ish file. */
function declaredDeps(text: string, file: string): string[] {
	const out: string[] = [];
	const f = basename(file).toLowerCase();
	if (f === "requirements.txt") {
		for (const line of text.split("\n")) {
			const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*([<>=!~].*)?$/);
			if (m && !line.trim().startsWith("#")) out.push(m[1]!);
		}
	} else if (f === "package.json") {
		for (const block of ["dependencies", "devDependencies"]) {
			const re = new RegExp(`"${block}"\\s*:\\s*\\{([^}]*)\\}`, "g");
			for (const m of text.matchAll(re)) {
				for (const pm of (m[1] ?? "").matchAll(/"([^"]+)"\s*:/g)) out.push(pm[1]!);
			}
		}
	}
	return out;
}

// ── What counts as a deployable artefact ─────────────────────────────────────
// A manifest gap only means something for a file that is *meant to ship*. Tests, docs and
// data fixtures never belong in a manifest, so flagging them produced ~12 false positives on a
// 38-file branch and trained the reader to skim past the section. A detector that cries wolf is
// worse than no detector.
const NEVER_DEPLOYED = [
	/^tests?\//i, /^test\//i, /^spec\//i, /^docs?\//i, /^documentation\//i,
	/^\.github\//i, /(^|\/)(conftest\.py|test_[^/]*|[^/]*_test\.[a-z]+|[^/]*\.test\.[a-z]+|[^/]*\.spec\.[a-z]+)$/i,
];
const DEPLOYED_LOCATIONS = /^(migrations?|scripts?|bin|deploy|ops|infra|terraform|helm|k8s|docker)\//i;
const DEPLOYED_SUFFIX = /\.(sql|service|timer|sh|ps1|yaml|yml|toml)$/i;

/** True when a path is plausibly shipped, so its absence from a manifest is a real question. */
export function isDeployableArtifact(path: string): boolean {
	const rel = path.split("\\").join("/");
	if (NEVER_DEPLOYED.some((rx) => rx.test(rel))) return false;
	if (DEPLOYED_LOCATIONS.test(rel)) return true;
	return DEPLOYED_SUFFIX.test(rel);
}

export function buildReport(cwd: string): JoinReport {
	const base = mergeBase(cwd);
	const empty: JoinReport = {
		repo: cwd, base: "", changedFiles: [], addedFiles: [], unreferencedFiles: [], manifestGaps: [],
		brokenSchedules: [], joinSymbols: [], unreferencedDependencies: [], findings: [], degraded: true,
	};
	if (!base) return empty;

	const changed = changedFilesOf(cwd, base);
	if (!changed.length) return { ...empty, base, degraded: false };

	const addedFiles = git(cwd, ["diff", "--diff-filter=A", "--name-only", `${base}...HEAD`])?.split("\n").map((l) => l.trim()).filter(Boolean) ?? [];

	// Everything searchable, and the added lines per changed file.
	const all = walk(cwd);
	const addedText = new Map<string, string>();
	for (const c of changed) {
		if (c.binary) continue;
		const d = git(cwd, ["diff", "--unified=0", `${base}...HEAD`, "--", c.file]);
		if (d === null) continue;
		addedText.set(
			c.file,
			d.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n"),
		);
	}

	// Index searchable text once, keyed by repo-relative path. Manifest-like files are
	// included by *name*, not extension: `deploy.manifest` and `Procfile` are exactly the
	// files this needs to see, and an extension filter silently excluded them.
	const isManifestName = (p: string) => MANIFEST_HINTS.some((h) => basename(p).toLowerCase().includes(h));
	const textByFile = new Map<string, string>();
	for (const abs of all) {
		const ext = extname(abs).toLowerCase();
		const include = CODE_EXT.has(ext) || /\.(md|env|conf|txt)$/i.test(abs) || isManifestName(relative(cwd, abs));
		if (!include) continue;
		const t = readText(abs);
		if (t !== null) textByFile.set(relative(cwd, abs).split("\\").join("/"), t);
	}

	const findings: Finding[] = [];

	// 1. A new file nothing else mentions.
	const unreferencedFiles: string[] = [];
	for (const f of addedFiles) {
		if (!isDeployableArtifact(f)) continue;
		const stem = basename(f, extname(f));
		if (!stem || stem.length < 3) continue;
		let refs = 0;
		for (const [p, t] of textByFile) {
			if (p === f) continue;
			if (t.includes(f) || new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) refs++;
		}
		if (refs === 0) {
			unreferencedFiles.push(f);
			findings.push({ kind: "unreferenced_file", subject: f, detail: "added on this branch and referenced by nothing else in the repo" });
		}
	}

	// 2. A deployable file no manifest-like file appears to cover.
	const manifests = [...textByFile.keys()].filter((p) => isManifestName(p));
	const manifestGaps: string[] = [];
	if (manifests.length > 0) {
		const manifestText = manifests.map((p) => textByFile.get(p) ?? "").join("\n");
		for (const f of addedFiles) {
			if (!isDeployableArtifact(f)) continue;
			const stem = basename(f, extname(f));
			if (!manifestText.includes(f) && !manifestText.includes(stem)) {
				manifestGaps.push(f);
				findings.push({ kind: "manifest_gap", subject: f, detail: `added, but no manifest (${manifests.length} found) mentions it — is it delivered?` });
			}
		}
	}

	// 3. A schedule pointing at a script that is not there.
	//
	// Only repo-relative targets can be checked against the repo. An absolute path is a host
	// path — `ExecStart=/home/.../venv/bin/python` in a systemd unit refers to the machine that
	// unit runs on, not this checkout, so "not present" is a meaningless verdict on it.
	const brokenSchedules: string[] = [];
	for (const s of scheduleTargets(cwd, all)) {
		const t = s.target.replace(/^\$\{?\w+\}?\//, "");
		if (!t || t.startsWith("http")) continue;
		if (t.startsWith("/") || /^[A-Za-z]:[\\/]/.test(t)) continue; // host path, not a repo path
		if (t.includes("/") && t.split("/").length > 2) continue; // e.g. a venv path baked into a unit
		const abs = pathResolve(cwd, t);
		if (existsSync(abs) || existsSync(pathResolve(cwd, "scripts", t)) || existsSync(pathResolve(cwd, "cron", t))) continue;
		brokenSchedules.push(`${s.entry} -> ${s.target}`);
		findings.push({ kind: "missing_schedule_target", subject: s.target, detail: `scheduled but not present in the repo: ${s.entry}` });
	}

	// 4. Symbols reachable from a changed file that other files call.
	//
	// Read the changed file's *current* content rather than only its added lines: the join
	// that matters is often a symbol whose definition did not move but whose file now sits on
	// a new call path. Restricted to added lines, it misses exactly that case.
	//
	// `joinSymbols` is CONTEXT — the changed file's exposed surface. Only symbols this branch
	// actually touched (mentioned in its own added lines, or newly defined by it) become
	// findings; a changed file that merely exports something old callers use is not a defect,
	// and reporting it as one is how a detector becomes noise.
	const joinSymbols: JoinReport["joinSymbols"] = [];
	const seenJoins = new Set<string>();
	for (const c of changed) {
		if (c.binary || !CALLABLE_EXT.has(extname(c.file).toLowerCase())) continue;
		const abs = pathResolve(cwd, c.file);
		const current = readText(abs);
		if (current === null) continue;
		const touchedText = addedText.get(c.file) ?? "";
		for (const sym of definedSymbols(current)) {
			// A dunder is not a join surface. `__init__` matching a file that happens to mention
			// it is noise, and it crowded out the real signals on a real branch.
			if (!sym || sym.length < 4 || /^__.*__$/.test(sym)) continue;
			const key = `${c.file}:${sym}`;
			if (seenJoins.has(key)) continue;
			const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const rx = new RegExp(`\\b${esc}\\b`);
			// A definition is not a call, and a file that defines the same name shadows it.
			// Four `migrate_*.py` files each DEFINE `run_migration` and each call their own —
			// the earlier grep counted the three sibling definitions as "callers" and invented a
			// join that did not exist. A shadowing file only counts if it also imports the
			// defining module, which is what a real cross-file call looks like.
			const defRx = new RegExp(`(?:def|function|func|fn|class|struct|interface|type|enum|const|let|var)\\s+${esc}\\b`);
			const stem = basename(c.file, extname(c.file));
			const stemEsc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const importRx = new RegExp(
				`(?:from\\s+[\\w./]*${stemEsc}\\s+import|require\\s*\\(\\s*["'][^"']*${stemEsc}|import\\s+["'][^"']*${stemEsc}|from\\s+[\\w./]*${stemEsc}\\s+import\\s+[^\\n]*\\b${esc}\\b)`,
			);
			const callers: string[] = [];
			for (const [p, t] of textByFile) {
				if (p === c.file) continue;
				// Docs and data fixtures mention symbols; they do not call them.
				if (!CALLABLE_EXT.has(extname(p).toLowerCase())) continue;
				if (!rx.test(t)) continue;
				if (defRx.test(t)) {
					// The file defines this name itself; it is a caller only if it also
					// references the defining module.
					if (!importRx.test(t)) continue;
				}
				callers.push(p);
			}
			if (callers.length === 0) continue;
			seenJoins.add(key);
			joinSymbols.push({ file: c.file, symbol: sym, callers: callers.slice(0, 6) });
			// A finding, not just context, only when this branch INTRODUCED the symbol.
			// On a branch that rewrites a module, nearly every symbol in it is "touched";
			// reporting them all is what turned a 38-file branch into 68 findings.
			const newlyDefined = definedSymbols(touchedText).includes(sym);
			if (newlyDefined) {
				findings.push({
					kind: "external_callers",
					subject: `${sym} (${c.file})`,
					detail: `introduced by this branch and already referenced by ${callers.length} other code file(s): ${callers.slice(0, 4).join(", ")}`,
				});
			}
		}
	}

	// 5. A dependency declared but imported nowhere on the branch.
	const unreferencedDependencies: string[] = [];
	const declared = new Map<string, string>();
	const declaringFiles = new Set<string>();
	for (const [p, t] of textByFile) {
		const base = basename(p).toLowerCase();
		if (base === "requirements.txt" || base === "package.json") {
			const deps = declaredDeps(t, p);
			if (deps.length === 0) continue;
			declaringFiles.add(p);
			for (const d of deps) declared.set(d.toLowerCase(), p);
		}
	}
	if (declared.size > 0) {
		// Search the WHOLE repo's code, not just the branch. A dependency imported by
		// unchanged code is perfectly used; only one imported nowhere at all is a question.
		// The declaring files themselves are excluded, or every dep satisfies its own check.
		const repoCode = [...textByFile.entries()]
			.filter(([p]) => !declaringFiles.has(p))
			.map(([, t]) => t.toLowerCase())
			.join("\n");
		for (const [dep, where] of declared) {
			const stem = dep.split(/[._-]/)[0] ?? dep;
			if (stem.length < 3) continue;
			if (!repoCode.includes(stem)) {
				unreferencedDependencies.push(`${dep} (${where})`);
				findings.push({ kind: "unreferenced_dependency", subject: dep, detail: `declared in ${where}, imported nowhere in this repo` });
			}
		}
	}

	return {
		repo: cwd, base, changedFiles: changed, addedFiles, unreferencedFiles, manifestGaps,
		brokenSchedules, joinSymbols, unreferencedDependencies, findings, degraded: false,
	};
}

function render(report: JoinReport): string {
	if (report.degraded) return "verify: no git branch diff is determinable here, so there is nothing to inventory.";
	if (!report.changedFiles.length) return "verify: the branch has no changes against its merge base.";
	const lines = [
		`verify — join surface of this branch (${report.changedFiles.length} changed file(s), ${report.addedFiles.length} added)`,
		"",
	];
	const section = (title: string, items: string[]) => {
		if (!items.length) return;
		lines.push(`${title}:`);
		for (const i of items) lines.push(`  - ${i}`);
		lines.push("");
	};
	section("New files nothing else in the repo references", report.unreferencedFiles);
	section("New files no manifest appears to deliver", report.manifestGaps);
	section("Scheduled entries pointing at something absent", report.brokenSchedules);
	section("Dependencies declared but not imported on this branch", report.unreferencedDependencies);
	section("Symbols this branch defines that other files already call", report.joinSymbols.map((j) => `${j.symbol} in ${j.file} — called by ${j.callers.join(", ")}`));
	if (!report.findings.length) {
		lines.push("No join-surface gaps found. That is not a clean bill of health: these are mechanical checks only.");
		lines.push("Still work the six questions — clock, empty results, partial failure, absent dependency, delivery path.");
	} else {
		lines.push(`${report.findings.length} item(s) above. Treat them as questions to answer, not as verdicts:`);
		lines.push("an unreferenced new file may be legitimately standalone, and a broken schedule may be a template.");
	}
	return lines.join("\n");
}

const VerifyJoinsParams = Type.Object({});

export default function (pi: ExtensionAPI) {
	let last: JoinReport | null = null;

	pi.registerTool({
		name: "verify_joins",
		label: "Verify Joins",
		description:
			"Inventory the join surface of the current branch: new files nothing references, new files no " +
			"manifest delivers, schedules pointing at absent scripts, dependencies nothing imports, and symbols " +
			"this branch defines that other files already call. Use it at the start of a review round to learn " +
			"where the risk is. It reports; it does not judge, and it never fails the call — a finding is a " +
			"question to answer, not a verdict.",
		promptSnippet: "Inventory the current branch's join surface before reviewing it",
		parameters: VerifyJoinsParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const report = buildReport(ctx.cwd);
			last = report;
			return { content: [{ type: "text", text: render(report) }], details: { report } };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("verify_joins")), 0, 0);
		},
	});

	pi.registerCommand("verify", {
		description: "Show this branch's join surface",
		handler: async (_args, ctx) => {
			const report = buildReport(ctx.cwd);
			last = report;
			ctx.ui.notify(render(report));
		},
	});

	pi.on("session_start", async (_e, ctx) => {
		const host = (globalThis as Record<string, unknown>)["__piSidebar"] as { register?: (id: string, r: (w: number, t: Theme, e: boolean) => string[]) => void } | undefined;
		if (!host?.register) return;
		host.register("verify", (w: number, t: Theme, e: boolean) => {
			const head = t.fg("toolTitle", t.bold(e ? "verify ▸" : "verify"));
			if (!last) return [head, t.fg("muted", "run /verify")];
			const top = last.degraded ? ["no diff determinable"] : last.findings.length ? [`${last.findings.length} join item(s)`] : ["no mechanical findings"];
			return [head, ...top.map((l) => t.fg("muted", l.slice(0, Math.max(4, w - 2))))];
		});
	});
}