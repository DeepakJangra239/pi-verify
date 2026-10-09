/**
 * verify — join-surface inventory for the scope under review, for pi.
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
 * Scope: anchored, not branch-wide. `buildReport(cwd, baselineHead?)` unions
 * committed-since-baseline + staged/unstaged worktree + untracked files, so edits
 * made via bash, by hand, or by another session count. Without a baseline it falls
 * back to the merge-base diff, then to a degraded empty report. The report always
 * states the range it covered, so staleness is checkable instead of assumed.
 *
 * Model-facing surface:
 *   - `verify_joins` — inventory of the scope's join surface, ranked and capped
 *
 * Human-facing surface:
 *   - `/verify` — same, as a sidebar section when pi-sidebar is present
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve as pathResolve, basename, extname, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

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

/** How the scope under review was determined. Always present, so staleness is checkable. */
export interface ScopeInfo {
	/** baseline = anchored at goal creation; mergebase = branch-diff fallback; worktree-only = no base; degraded = nothing determinable. */
	kind: "baseline" | "mergebase" | "worktree-only" | "degraded";
	/** Human-readable range, e.g. "a1b2c3d4..e5f60718 + worktree (2) + untracked (1)". */
	range: string;
	untrackedCount: number;
	/** True when display lists were capped; see `withheld`. */
	truncated: boolean;
}

export interface JoinReport {
	repo: string;
	base: string;
	changedFiles: ChangedFile[];
	addedFiles: string[];
	/** New files nothing else in the repo references (via an import edge). */
	unreferencedFiles: string[];
	/** New files that no manifest-like file appears to cover. */
	manifestGaps: string[];
	/** Scheduled entries whose target script does not exist. */
	brokenSchedules: string[];
	/** Symbols this scope newly exposes that other files reference through an import edge. */
	joinSymbols: { file: string; symbol: string; callers: string[] }[];
	/** Dependency declarations nothing in the repo imports. */
	unreferencedDependencies: string[];
	findings: Finding[];
	/** True when nothing could be determined (not a repo, no base, no worktree changes). */
	degraded: boolean;
	scope: ScopeInfo;
	/** Non-shipped-role definers withheld from joinSymbols (count only, not findings). */
	withheldNonShipped: number;
	/** Join-symbol entries withheld by the display cap (count only). */
	withheldCapped: number;
	/** Shape flags: which detector families applied to this repo. */
	shape: { hasManifests: boolean; hasSchedules: boolean };
}

/** Cap on displayed join-symbol entries. The rest are counted in `withheldCapped`, not dropped silently. */
export const MAX_JOIN_SYMBOLS = 15;

/**
 * Generic non-shipped roles, matched by path segment — deliberately NOT a list of
 * directory names, because user directory names are unknowable. A segment matches
 * when it is exactly (case-insensitive, plural-tolerant) one of these role words,
 * or starts with `test`/`spec` (test_*, tests, specs), or is a dot-dir. Users extend
 * or override via `verify.json` (`excludeRoles` adds regexes, `includePaths` forces
 * inclusion). Anything unmatched here is treated as shippable code.
 */
const NONSHIPPED_SEGMENTS = new Set([
	"test", "tests", "spec", "specs", "testing",
	"doc", "docs", "documentation", "note", "notes",
	"evidence", "example", "examples", "fixture", "fixtures",
	"mock", "mocks", "proof", "proofs", "research", "design",
	"demo", "demos", "sample", "samples", "sandbox", "scratch", "tmp",
]);
const NONSHIPPED_FILES = [
	/(^|\/)(conftest\.py|test_[^/]*|[^/]*[._-]test\.[a-z]+|[^/]*\.test\.[a-z]+|[^/]*\.spec\.[a-z]+)$/i,
	/(^|\/)README(\.[a-z]+)?$/i,
];

export interface VerifyConfig {
	excludeRoles: string[];
	includePaths: string[];
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** User overrides from `<cwd>/.pi/verify.json`, then the global agent dir. Invalid regexes are ignored. */
export function loadVerifyConfig(cwd: string): VerifyConfig {
	const out: VerifyConfig = { excludeRoles: [], includePaths: [] };
	for (const p of [join(agentDir(), "verify.json"), join(cwd, CONFIG_DIR_NAME, "verify.json")]) {
		if (!existsSync(p)) continue;
		try {
			const j = JSON.parse(readFileSync(p, "utf8"));
			if (Array.isArray(j.excludeRoles)) for (const r of j.excludeRoles) if (typeof r === "string" && r) out.excludeRoles.push(r);
			if (Array.isArray(j.includePaths)) for (const r of j.includePaths) if (typeof r === "string" && r) out.includePaths.push(r);
		} catch {
			/* malformed — ignore */
		}
	}
	return out;
}

/** True when a repo-relative path plays a non-shipped role (test, doc, evidence, fixture, dot-dir, generated). */
export function isNonShipped(relPath: string, cfg?: VerifyConfig): boolean {
	const rel = relPath.split("\\").join("/");
	const config = cfg ?? { excludeRoles: [], includePaths: [] };
	for (const inc of config.includePaths) {
		try {
			if (new RegExp(inc, "i").test(rel)) return false;
		} catch {
			/* ignore bad regex */
		}
	}
	const segments = rel.split("/");
	for (const seg of segments) {
		const s = seg.toLowerCase();
		if (s.startsWith(".")) return true;
		const singular = s.endsWith("s") ? s.slice(0, -1) : s;
		if (NONSHIPPED_SEGMENTS.has(s) || NONSHIPPED_SEGMENTS.has(singular)) return true;
		if (/^(test|spec)/i.test(s)) return true;
	}
	if (NONSHIPPED_FILES.some((rx) => rx.test(rel))) return true;
	for (const pat of config.excludeRoles) {
		try {
			if (new RegExp(pat, "i").test(rel)) return true;
		} catch {
			/* ignore bad regex */
		}
	}
	return false;
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
	return scopeRows(cwd, base).rows;
}

interface ScopeRows {
	rows: ChangedFile[];
	addedFiles: string[];
	untracked: string[];
	worktreeFiles: string[];
}

/** Parse `git diff --numstat` output into rows. Binary files report "-". */
function parseNumstat(out: string | null): ChangedFile[] {
	if (out === null) return [];
	const rows: ChangedFile[] = [];
	for (const line of out.split("\n")) {
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const file = parts[2]!.trim();
		if (!file) continue;
		const a = Number(parts[0]);
		const d = Number(parts[1]);
		rows.push({ file, added: a, removed: d, binary: !Number.isFinite(a) || !Number.isFinite(d) });
	}
	return rows;
}

/**
 * Anchored scope rows: `git diff <base>` (no HEAD) covers committed-since-base
 * AND staged/unstaged worktree in one shot. `git diff HEAD` is read separately
 * — never merged — so the scope label can state the worktree part on its own.
 */
function scopeRows(cwd: string, base: string): ScopeRows {
	const merged = new Map<string, ChangedFile>();
	for (const r of parseNumstat(git(cwd, ["diff", "--numstat", base]))) {
		merged.set(r.file, { ...r });
	}
	const worktreeFiles = parseNumstat(git(cwd, ["diff", "--numstat", "HEAD"])).map((r) => r.file);
	const untracked = untrackedFiles(cwd);
	for (const f of untracked) {
		if (!merged.has(f)) merged.set(f, { file: f, added: 0, removed: 0, binary: false });
	}
	const addedCommitted = git(cwd, ["diff", "--diff-filter=A", "--name-only", `${base}...HEAD`])?.split("\n").map((l) => l.trim()).filter(Boolean) ?? [];
	const addedWorktree = git(cwd, ["diff", "--diff-filter=A", "--name-only", "HEAD"])?.split("\n").map((l) => l.trim()).filter(Boolean) ?? [];
	const addedFiles = [...new Set([...addedCommitted, ...addedWorktree, ...untracked])];
	return { rows: [...merged.values()], addedFiles, untracked, worktreeFiles };
}

/** Untracked, non-ignored files, repo-relative. Empty outside a repo. */
export function untrackedFiles(cwd: string): string[] {
	const out = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
	if (out === null) return [];
	return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Short human label for the resolved scope. */
function scopeRangeLabel(scope: { base: string; kind: ScopeInfo["kind"] }, worktreeCount: number, untrackedCount: number): string {
	if (scope.kind === "degraded") return "nothing determinable";
	if (scope.kind === "worktree-only") return `worktree vs HEAD (${worktreeCount}) + untracked (${untrackedCount})`;
	const short = scope.base.slice(0, 8);
	const wt = worktreeCount ? ` + worktree (${worktreeCount})` : "";
	const ut = untrackedCount ? ` + untracked (${untrackedCount})` : "";
	return scope.kind === "baseline" ? `${short}..HEAD${wt}${ut}` : `${short}...HEAD${wt}${ut} (branch fallback)`;
}
/**
 * Resolve the review scope: anchored at `baselineHead` when given and still
 * resolvable (covers N commits on one branch), else the merge-base fallback,
 * else worktree-only, else degraded. Shared shape with pi-goal's scope logic.
 */
export function resolveScope(cwd: string, baselineHead?: string): { base: string; kind: ScopeInfo["kind"] } {
	if (baselineHead && git(cwd, ["cat-file", "-e", baselineHead]) !== null) {
		return { base: baselineHead, kind: "baseline" };
	}
	const base = mergeBase(cwd);
	if (base) return { base, kind: "mergebase" };
	// No base, but a repo with worktree content is still reviewable.
	if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== null) return { base: "", kind: "worktree-only" };
	return { base: "", kind: "degraded" };
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

/**
 * High-collision generic identifiers. Matching these across a repo produces
 * word-collision noise (`data`, `status`, `main` in every file), never a join.
 * Withheld from the ranked display and never reported as findings.
 */
const GENERIC_SYMBOLS = new Set([
	"main", "seed", "data", "status", "today", "time", "date", "message", "body",
	"kind", "next", "match", "state", "detail", "result", "total", "params", "type",
	"index", "target", "label", "text", "html", "live", "diff", "capture", "run",
	"value", "item", "items", "name", "id", "ref", "refs",
]);

/**
 * Symbols a file's text actually *exports* — not every local it mentions.
 * Python: top-level (column-0) def/class only. JS/TS: `export ...` declarations,
 * `export { a, b }` lists, and `module.exports`/`exports.x` forms. Other
 * languages keep the generic declaration match. Locals (`const data = ...`
 * without export, indented defs) are never join surface.
 */
export function exportedSymbols(text: string, file: string): string[] {
	const out = new Set<string>();
	const ext = extname(file).toLowerCase();
	if (ext === ".py") {
		for (const m of text.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) out.add(m[1]!);
		return [...out];
	}
	if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
		for (const m of text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|enum|interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) out.add(m[1]!);
		for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) {
			for (const part of (m[1] ?? "").split(",")) {
				const name = part.trim().split(/\s+as\s+/).pop()?.trim().replace(/[^A-Za-z0-9_$]/g, "");
				if (name) out.add(name);
			}
		}
		for (const m of text.matchAll(/module\.exports\s*=\s*\{([^}]+)\}/g)) {
			for (const part of (m[1] ?? "").split(",")) {
				const name = part.trim().split(/[:\s]/)[0]?.trim().replace(/[^A-Za-z0-9_$]/g, "");
				if (name) out.add(name);
			}
		}
		for (const m of text.matchAll(/exports\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) out.add(m[1]!);
		return [...out];
	}
	for (const m of text.matchAll(/^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:def|function|func|fn|class|struct|interface|type|enum|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) out.add(m[1]!);
	return [...out];
}

/** Crontab / systemd / CI schedule entries and the paths they point at. */
function scheduleTargets(cwd: string, files: string[]): { entry: string; target: string }[] {
	const out: { entry: string; target: string }[] = [];
	const schedLike = (f: string) => isScheduleLike(f) || isScheduleLike(basename(f));
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

/** Dependency names declared by a manifest-ish file. Python/JS plus Go/Rust/TOML/Ruby. */
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
	} else if (f === "go.mod") {
		for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9][a-z0-9./_-]*)\s+v\d/gm)) out.push(m[1]!);
	} else if (f === "cargo.toml") {
		const section = text.match(/\[dependencies\][\s\S]*?(?=\n\[|\s*$)/);
		if (section) for (const m of section[0].matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) out.push(m[1]!);
	} else if (f === "pyproject.toml") {
		const section = text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
		if (section) for (const m of (section[1] ?? "").matchAll(/["']([A-Za-z0-9_.-]+)/g)) out.push(m[1]!);
	} else if (f === "gemfile") {
		for (const m of text.matchAll(/^\s*gem\s+["']([A-Za-z0-9_.-]+)["']/gm)) out.push(m[1]!);
	}
	return out;
}

const DEP_FILES = new Set(["requirements.txt", "package.json", "go.mod", "cargo.toml", "pyproject.toml", "gemfile"]);

// ── What counts as a deployable artefact ─────────────────────────────────────
// A manifest gap only means something for a file that is *meant to ship*.
// Non-shipped roles (tests, docs, evidence, fixtures — matched generically via
// isNonShipped, user-overridable in verify.json) never belong in a manifest, so
// flagging them trained the reader to skim past the section. A detector that
// cries wolf is worse than no detector.
const DEPLOYED_LOCATIONS = /^(migrations?|scripts?|bin|deploy|ops|infra|terraform|helm|k8s|docker)\//i;
const DEPLOYED_SUFFIX = /\.(sql|service|timer|sh|ps1|yaml|yml|toml)$/i;

/** True when a path is plausibly shipped, so its absence from a manifest is a real question. */
export function isDeployableArtifact(path: string): boolean {
	const rel = path.split("\\").join("/");
	if (isNonShipped(rel)) return false;
	if (DEPLOYED_LOCATIONS.test(rel)) return true;
	return DEPLOYED_SUFFIX.test(rel);
}

/** Repo-shape probe: which detector families apply here at all. */
function detectShape(cwd: string, textByFile: Map<string, string>): { hasManifests: boolean; hasSchedules: boolean } {
	const isManifestName = (p: string) => MANIFEST_HINTS.some((h) => basename(p).toLowerCase().includes(h));
	const hasManifests = [...textByFile.keys()].some((p) => isManifestName(p));
	const hasSchedules =
		[...textByFile.keys()].some((p) => isScheduleLike(p)) ||
		["migrations", "migrate", "cron", "deploy", "ops", "infra", ".github"].some((d) => {
			try {
				return statSync(join(cwd, d)).isDirectory();
			} catch {
				return false;
			}
		});
	return { hasManifests, hasSchedules };
}

/** Schedule-like file by name (cron, systemd, workflow). Extracted for shape probing. */
function isScheduleLike(rel: string): boolean {
	return (
		/(^|\/)(crontab|cron|.*\.timer|.*\.cron|.*\.service)$/i.test(rel) ||
		/(\.github\/workflows\/.*\.ya?ml)$/i.test(rel) ||
		/(^|\/)(crontab|.*\.cron)$/i.test(basename(rel))
	);
}

/** Import-edge matcher: does `text` import the module `stem` (any language form)? */
function importRxFor(stem: string): RegExp {
	const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`(?:from\\s+["']?[\\w./-]*${esc}\\b|import\\s+[^;\\n]*${esc}|require\\s*\\(\\s*["'][^"']*${esc})`,
	);
}

/** True when a manifest covers file `f`: full path, stem, or any ancestor directory is named. */
function manifestCovers(manifestText: string, f: string): boolean {
	if (manifestText.includes(f)) return true;
	const stem = basename(f, extname(f));
	if (stem && manifestText.includes(stem)) return true;
	const segs = f.split("/");
	for (let k = segs.length - 1; k >= 1; k--) {
		const dir = segs.slice(0, k).join("/") + "/";
		if (manifestText.includes(dir)) return true;
	}
	return false;
}

export function buildReport(cwd: string, baselineHead?: string): JoinReport {
	const scope = resolveScope(cwd, baselineHead);
	const cfg = loadVerifyConfig(cwd);
	const empty: JoinReport = {
		repo: cwd, base: scope.base, changedFiles: [], addedFiles: [], unreferencedFiles: [], manifestGaps: [],
		brokenSchedules: [], joinSymbols: [], unreferencedDependencies: [], findings: [], degraded: true,
		scope: { kind: scope.kind, range: scopeRangeLabel(scope, 0, 0), untrackedCount: 0, truncated: false },
		withheldNonShipped: 0, withheldCapped: 0, shape: { hasManifests: false, hasSchedules: false },
	};
	if (scope.kind === "degraded") return empty;

	const workBase = scope.kind === "worktree-only" ? "HEAD" : scope.base;
	const { rows: changed, addedFiles, untracked, worktreeFiles } = scopeRows(cwd, workBase);
	if (!changed.length) {
		return {
			...empty, base: scope.base, degraded: false,
			scope: { kind: scope.kind, range: scopeRangeLabel(scope, worktreeFiles.length, untracked.length), untrackedCount: untracked.length, truncated: false },
		};
	}

	// Everything searchable, and the added lines per changed file. Untracked files
	// have no diff — their full content is the added surface.
	const all = walk(cwd);
	const addedText = new Map<string, string>();
	for (const c of changed) {
		if (c.binary) continue;
		const d = scope.kind === "worktree-only" ? null : git(cwd, ["diff", "--unified=0", `${scope.base}`, "--", c.file]);
		const lines = d === null ? [] : d.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
		if (!lines.length && addedFiles.includes(c.file)) {
			const t = readText(pathResolve(cwd, c.file));
			if (t !== null) lines.push(...t.split("\n"));
		}
		addedText.set(c.file, lines.join("\n"));
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

	// 1. A new file nothing else references — via an import edge or a path mention.
	// A bare word-match is not a reference (it produced callers like `data.json`
	// for a symbol named `data`); the referrer must import the file's module or
	// name its path.
	const unreferencedFiles: string[] = [];
	for (const f of addedFiles) {
		if (!isDeployableArtifact(f)) continue;
		const stem = basename(f, extname(f));
		if (!stem || stem.length < 3) continue;
		const wordRx = new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
		const edgeRx = importRxFor(stem);
		let refs = 0;
		for (const [p, t] of textByFile) {
			if (p === f) continue;
			if (t.includes(f) || (wordRx.test(t) && edgeRx.test(t))) refs++;
		}
		if (refs === 0) {
			unreferencedFiles.push(f);
			findings.push({ kind: "unreferenced_file", subject: f, detail: "added in this scope and referenced by nothing else in the repo" });
		}
	}

	// 2. A deployable file no manifest-like file appears to cover. Coverage is by
	// path, stem, or ancestor directory — a manifest that ships a whole static dir
	// covers the new fonts inside it. Runs only when manifests exist (shape-gated).
	const manifests = [...textByFile.keys()].filter((p) => MANIFEST_HINTS.some((h) => basename(p).toLowerCase().includes(h)));
	const manifestGaps: string[] = [];
	if (manifests.length > 0) {
		const manifestText = manifests.map((p) => textByFile.get(p) ?? "").join("\n");
		for (const f of addedFiles) {
			if (!isDeployableArtifact(f)) continue;
			if (!manifestCovers(manifestText, f)) {
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

	// 4. Symbols this scope newly exposes that other files reference through an
	// import edge.
	//
	// Read the changed file's *current* content rather than only its added lines: the join
	// that matters is often a symbol whose definition did not move but whose file now sits on
	// a new call path. Restricted to added lines, it misses exactly that case.
	//
	// Three precision rules keep this from becoming word-collision noise:
	// exports-only (a `const data = ...` local is not join surface), import-edge
	// callers (mentioning a name is not calling it), and generic-name suppression.
	// Non-shipped roles (tests, docs, evidence — matched generically, see
	// isNonShipped) are withheld as definers and counted, not reported.
	// `allJoins` is context; only scope-INTRODUCED symbols become findings, ranked
	// (introduced first, then caller count) and capped at MAX_JOIN_SYMBOLS.
	const allJoins: { file: string; symbol: string; callers: string[]; introduced: boolean }[] = [];
	const seenJoins = new Set<string>();
	let withheldNonShipped = 0;
	for (const c of changed) {
		if (c.binary || !CALLABLE_EXT.has(extname(c.file).toLowerCase())) continue;
		if (isNonShipped(c.file, cfg)) {
			const t = readText(pathResolve(cwd, c.file));
			if (t !== null) withheldNonShipped += exportedSymbols(t, c.file).filter((s) => s && s.length >= 4 && !/^__.*__$/.test(s) && !GENERIC_SYMBOLS.has(s)).length;
			continue;
		}
		const abs = pathResolve(cwd, c.file);
		const current = readText(abs);
		if (current === null) continue;
		const touchedText = addedText.get(c.file) ?? "";
		const introducedSet = new Set(exportedSymbols(touchedText, c.file));
		for (const sym of exportedSymbols(current, c.file)) {
			// A dunder is not a join surface, and neither is a generic name that
			// collides across every file in the repo.
			if (!sym || sym.length < 4 || /^__.*__$/.test(sym) || GENERIC_SYMBOLS.has(sym)) continue;
			const key = `${c.file}:${sym}`;
			if (seenJoins.has(key)) continue;
			const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const rx = new RegExp(`\\b${esc}\\b`);
			// A definition is not a call. A file only counts as a caller when it
			// references the defining module through an import edge — a bare
			// mention without one is not a call.
			const stem = basename(c.file, extname(c.file));
			const edgeRx = importRxFor(stem);
			const callers: string[] = [];
			for (const [p, t] of textByFile) {
				if (p === c.file) continue;
				// Docs and data fixtures mention symbols; they do not call them.
				if (!CALLABLE_EXT.has(extname(p).toLowerCase())) continue;
				if (!rx.test(t)) continue;
				if (!edgeRx.test(t)) continue;
				callers.push(p);
			}
			if (callers.length === 0) continue;
			seenJoins.add(key);
			allJoins.push({ file: c.file, symbol: sym, callers, introduced: introducedSet.has(sym) });
		}
	}
	allJoins.sort((a, b) => Number(b.introduced) - Number(a.introduced) || b.callers.length - a.callers.length);
	const withheldCapped = Math.max(0, allJoins.length - MAX_JOIN_SYMBOLS);
	const joinSymbols: JoinReport["joinSymbols"] = allJoins.slice(0, MAX_JOIN_SYMBOLS).map(({ file, symbol, callers }) => ({ file, symbol, callers: callers.slice(0, 6) }));
	for (const j of allJoins.slice(0, MAX_JOIN_SYMBOLS)) {
		if (!j.introduced) continue;
		findings.push({
			kind: "external_callers",
			subject: `${j.symbol} (${j.file})`,
			detail: `introduced in this scope and already referenced by ${j.callers.length} other code file(s): ${j.callers.slice(0, 4).join(", ")}`,
		});
	}

	// 5. A dependency declared but imported nowhere in the repo.
	const unreferencedDependencies: string[] = [];
	const declared = new Map<string, string>();
	const declaringFiles = new Set<string>();
	for (const [p, t] of textByFile) {
		const base = basename(p).toLowerCase();
		if (DEP_FILES.has(base)) {
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

	const shape = detectShape(cwd, textByFile);
	const truncated = withheldCapped > 0;
	return {
		repo: cwd, base: scope.base, changedFiles: changed, addedFiles, unreferencedFiles, manifestGaps,
		brokenSchedules, joinSymbols, unreferencedDependencies, findings, degraded: false,
		scope: { kind: scope.kind, range: scopeRangeLabel(scope, worktreeFiles.length, untracked.length), untrackedCount: untracked.length, truncated },
		withheldNonShipped, withheldCapped, shape,
	};
}

function render(report: JoinReport): string {
	if (report.degraded) return "verify: no review scope is determinable here (not a repo, no baseline, no worktree changes), so there is nothing to inventory.";
	if (!report.changedFiles.length) return "verify: the review scope has no changes.";
	const lines = [
		`verify — join surface of this scope (${report.changedFiles.length} changed file(s), ${report.addedFiles.length} added; scope ${report.scope.range})`,
		"",
	];
	const section = (title: string, items: string[]) => {
		if (!items.length) return;
		lines.push(`${title}:`);
		for (const i of items) lines.push(`  - ${i}`);
		lines.push("");
	};
	section("New files nothing else in the repo references (import edge or path)", report.unreferencedFiles);
	if (report.shape.hasManifests) {
		section("New files no manifest appears to deliver", report.manifestGaps);
	} else {
		lines.push("Manifest coverage: not applicable to this repo shape (no manifests found).");
		lines.push("");
	}
	if (report.shape.hasSchedules || report.brokenSchedules.length) {
		section("Scheduled entries pointing at something absent", report.brokenSchedules);
	} else {
		lines.push("Schedules: not applicable to this repo shape (no schedules found).");
		lines.push("");
	}
	section("Dependencies declared but imported nowhere", report.unreferencedDependencies);
	section("Symbols this scope exposes that other files reference (import edge)", report.joinSymbols.map((j) => `${j.symbol} in ${j.file} — referenced by ${j.callers.join(", ")}`));
	if (report.withheldNonShipped > 0) {
		lines.push(`Withheld: ${report.withheldNonShipped} symbol(s) in non-shipped roles (tests, docs, evidence, fixtures) — counted, not reported.`);
	}
	if (report.withheldCapped > 0) {
		lines.push(`Withheld: ${report.withheldCapped} further symbol(s) beyond the top ${MAX_JOIN_SYMBOLS} — ranked by introduced-first, caller count.`);
	}
	if (lines.length && (report.withheldNonShipped > 0 || report.withheldCapped > 0)) lines.push("");
	if (!report.findings.length) {
		lines.push("No join-surface gaps found. That is not a clean bill of health: these are mechanical checks only.");
		lines.push("Still work the review questions — correctness, architecture, complexity, quality, dev-test evidence.");
	} else {
		lines.push(`${report.findings.length} item(s) above. Treat them as questions to answer, not as verdicts:`);
		lines.push("an unreferenced new file may be legitimately standalone, and a broken schedule may be a template.");
	}
	return lines.join("\n");
}

const VerifyJoinsParams = Type.Object({
	baselineHead: Type.Optional(Type.String({ description: "Goal baseline SHA: scope anchored at goal creation (covers N commits + worktree + untracked)" })),
});

export default function (pi: ExtensionAPI) {
	let last: JoinReport | null = null;

	pi.registerTool({
		name: "verify_joins",
		label: "Verify Joins",
		description:
			"Inventory the join surface of the current review scope (anchored at the goal baseline when " +
			"given, else the merge-base fallback): new files nothing references, new files no manifest delivers, " +
			"schedules pointing at absent scripts, dependencies nothing imports, and symbols this scope " +
			"exposes that other files reference through an import edge. On-demand diagnostic for a review " +
			"round, not a mandatory pre-pass. It reports; it does not judge, and it never fails the call — " +
			"a finding is a question to answer, not a verdict.",
		promptSnippet: "Inventory the current review scope's join surface (on-demand diagnostic)",
		parameters: VerifyJoinsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const report = buildReport(ctx.cwd, params.baselineHead);
			last = report;
			return { content: [{ type: "text", text: render(report) }], details: { report } };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("verify_joins")), 0, 0);
		},
	});

	pi.registerCommand("verify", {
		description: "Show this review scope's join surface",
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