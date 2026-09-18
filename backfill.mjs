#!/usr/bin/env node
/**
 * VG Brain — find old Claude transcripts on this Mac, then send them to your
 * own private notes.
 *
 * Back in the days when Claude Code and Cowork kept your chats on your own
 * machine, every session left a .jsonl transcript behind. Claude keeps chats in
 * the cloud now, so nothing new lands on disk — but the old files are still
 * there, and the brain never saw them. This finds them and hands them over.
 *
 * Get it:
 *
 *   curl -fsSL https://raw.githubusercontent.com/liamsands-arch/vg-brain-backfill/main/backfill.mjs -o backfill.mjs
 *
 * Then it runs in two steps, and the first one never touches the network:
 *
 *   node backfill.mjs            # LOOK: what's on this machine?
 *   node backfill.mjs --send     # SEND: upload it
 *
 * Everything you send lands in YOUR OWN notes. Nobody else can read it unless
 * you share it later, one note at a time. The server reads the transcripts,
 * pulls out the durable pieces (a decision and why, a method, a number that got
 * reconciled) and files those; the raw chat itself is not published anywhere.
 *
 * Useful flags:
 *   --list                 show every file, not just a per-project roll-up
 *   --since=2025-01-01     only sessions that ended on/after this date
 *   --until=2026-06-30     only sessions that ended on/before this date
 *   --project=acme         only folders whose name contains this text
 *   --exclude=sandbox      skip folders whose name contains this text
 *                          (repeat --project / --exclude as many times as you like)
 *   --min-messages=6       skip thin sessions (default 4; --min-messages=0 for all)
 *   --limit=1              only the N most recent chats — good for trying one first
 *   --path=/some/dir       also search here
 *   --quick                skip reading the files (sizes and dates only)
 *   --json                 machine-readable scan output
 *   --login                sign in with your own Google account, in your browser
 *   --logout               forget the saved sign-in on this Mac
 *   --whoami               check the login and print who the server thinks you are
 *   --yes                  don't ask before uploading
 *   --delay-ms=750         pause between uploads
 *
 * Signing in: run `node backfill.mjs --login` and a browser opens. Sign in with
 * the same Google account you use for VG Brain and you're done — the sign-in is
 * saved on this Mac. If you've already installed the VG Brain connector, the
 * script finds that login on its own and you can skip even this.
 *
 * Node 18 or newer. No install, no dependencies.
 */

import { createReadStream, existsSync, readdirSync, readFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { createInterface as createPrompt } from "node:readline/promises";
import { join, basename, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { request as httpsRequest } from "node:https";
import { request as httpRequest, createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, createHash as sha256 } from "node:crypto";
import { writeFileSync, chmodSync, unlinkSync } from "node:fs";

// --- arguments -------------------------------------------------------------

function parseArgs(argv) {
  const flags = { project: [], exclude: [], path: [] };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/i.exec(arg);
    if (!m) {
      die(`don't know what to do with "${arg}". Run with --help.`);
    }
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === "project" || key === "exclude" || key === "path") {
      if (!val) die(`--${key} needs a value, like --${key}=something`);
      flags[key].push(val);
    } else {
      flags[key] = val === undefined ? true : val;
    }
  }
  return flags;
}

function die(msg) {
  process.stderr.write(`\nvg-brain-backfill: ${msg}\n\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  process.stdout.write(readFileSync(new URL(import.meta.url)).toString().split("\n")
    .filter((l) => l.startsWith(" *") || l.startsWith("/**"))
    .map((l) => l.replace(/^\/\*\*$/, "").replace(/^ \* ?/, "").replace(/^ \*\/?$/, ""))
    .join("\n").trim() + "\n");
  process.exit(0);
}

// Whatever they saved it as — the hints below should echo what they typed, not
// what we happened to name the file.
const ME = basename(process.argv[1] || "backfill.mjs");
// Set when main() signs in up front, so send() uses that instead of resolving
// again (a resolve would re-read the file we just wrote — harmless, but this is
// the same shape as the bug where a stale env var shadowed a fresh login).
let preAuth = null;
const HOME = homedir();
// vg-brain.com, not the fly.dev name. Both front the same app, but the Google
// sign-in callback is registered against the .com host — go through fly.dev and
// Google refuses the handoff with redirect_uri_mismatch before you ever reach a
// password box. VG_BRAIN_URL overrides for anyone who needs it.
const BASE = String(process.env.VG_BRAIN_URL || "https://vg-brain.com").replace(/\/+$/, "");
const MIN_MESSAGES = args["min-messages"] === undefined ? 4 : Number(args["min-messages"]);
const DELAY_MS = args["delay-ms"] === undefined ? 750 : Number(args["delay-ms"]);
const LIMIT = args.limit === undefined ? null : Number(args.limit);
const SINCE = args.since ? Date.parse(args.since + "T00:00:00Z") : null;
const UNTIL = args.until ? Date.parse(args.until + "T23:59:59Z") : null;

if (Number.isNaN(MIN_MESSAGES)) die("--min-messages needs a number");
if (Number.isNaN(DELAY_MS)) die("--delay-ms needs a number");
if (LIMIT !== null && (!Number.isFinite(LIMIT) || LIMIT < 1)) die("--limit needs a whole number, 1 or more");
if (args.since && Number.isNaN(SINCE)) die("--since needs a date like 2025-01-01");
if (args.until && Number.isNaN(UNTIL)) die("--until needs a date like 2026-06-30");

// --- where Claude used to keep transcripts on a Mac ------------------------
//
// Claude Code writes one .jsonl per session under ~/.claude/projects/<slug>/.
// Cowork and the desktop app kept local agent sessions under Application
// Support. Anything that isn't there is found by --path.

function candidateRoots() {
  const roots = [
    { dir: join(HOME, ".claude", "projects"), what: "Claude Code" },
    { dir: join(HOME, ".config", "claude", "projects"), what: "Claude Code" },
    { dir: join(HOME, "Library", "Application Support", "Claude"), what: "Claude desktop / Cowork" },
    { dir: join(HOME, "Library", "Application Support", "Cowork"), what: "Cowork" },
    { dir: join(HOME, ".cowork"), what: "Cowork" },
  ];
  for (const p of args.path) roots.push({ dir: p.replace(/^~(?=$|\/)/, HOME), what: "you asked for this one" });
  return roots.filter((r) => existsSync(r.dir));
}

// Directory names that never hold a transcript and can hold tens of thousands
// of files. Walking into them is the difference between four seconds and four
// minutes.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "Cache", "Caches", "GPUCache", "Code Cache",
  "blob_storage", "Crashpad", "logs", "Partitions", "Service Worker",
  "Local Storage", "Session Storage", "IndexedDB", "DawnCache",
  "component_crx_cache", "Dictionaries",
]);

function walk(dir, depth, out) {
  if (depth < 0) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable (permissions, a dead symlink) — not our problem
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, depth - 1, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

// --- is this actually a Claude transcript? ---------------------------------
//
// Cheap test: read the head of the file and look for a record that carries a
// user or assistant turn. A .jsonl of log lines or telemetry won't have one.

function looksLikeTranscript(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(64 * 1024);
    const got = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.slice(0, got).toString("utf8");
    for (const line of head.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      let obj;
      try { obj = JSON.parse(t); } catch { continue; } // last line is usually cut
      const role = obj?.message?.role ?? obj?.role ?? obj?.type;
      if (role === "user" || role === "assistant") return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

// --- reading one transcript ------------------------------------------------

function readStats(path) {
  return new Promise((resolve) => {
    let user = 0, assistant = 0, first = null, last = null;
    const rl = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t.startsWith("{")) return;
      let obj;
      try { obj = JSON.parse(t); } catch { return; }
      const role = obj?.message?.role ?? obj?.role ?? obj?.type;
      if (role !== "user" && role !== "assistant") return;
      if (role === "user") user++; else assistant++;
      const ts = Date.parse(obj?.timestamp ?? obj?.ts ?? obj?.message?.timestamp ?? "");
      if (!Number.isNaN(ts)) {
        if (first === null || ts < first) first = ts;
        if (last === null || ts > last) last = ts;
      }
    });
    rl.on("close", () => resolve({ user, assistant, first, last }));
    rl.on("error", () => resolve({ user, assistant, first, last }));
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The server keys a staged transcript on (you, session_id), so this has to be
// the SAME string every run or a second pass would stage duplicates. Claude
// Code names the file after the session, which is ideal. Anything else gets a
// hash of its path, which is just as stable.
function sessionIdFor(path) {
  const stem = basename(path).replace(/\.jsonl$/i, "");
  if (UUID_RE.test(stem)) return stem.toLowerCase();
  const folder = /(^|[\\/])local_([0-9a-f-]{36})([\\/]|$)/i.exec(path);
  if (folder && UUID_RE.test(folder[2])) return folder[2].toLowerCase();
  const h = createHash("sha1").update(path).digest("hex").slice(0, 12);
  return `backfill-${h}`;
}

// Claude Code encodes the working directory into the folder name by replacing
// every slash with a dash: /Users/sam/code/acme -> -Users-sam-code-acme. The
// last segment is the part a human recognizes.
function projectLabelFor(path) {
  // Cowork first. Each local agent session runs in its own local_<uuid>
  // container that carries a WHOLE .claude/projects/ tree inside it, so the
  // Claude Code branch below would otherwise win and label every one of them
  // after whatever the container's cwd happened to be — 100+ rows all reading
  // "outputs". They are one thing to a human: Cowork chats.
  if (/local-agent-mode-sessions/.test(path)) return "Cowork  (local sessions)";
  if (/[\\/]local_[0-9a-f-]{36}([\\/]|$)/i.test(path)) return "Cowork  (local sessions)";

  const parts = path.split(sep);
  const i = parts.lastIndexOf("projects");
  if (i >= 0 && parts.length > i + 1) {
    const slug = parts[i + 1];
    const tail = slug.split("-").filter(Boolean).pop();
    return tail ? `${tail}  (${slug})` : slug;
  }
  return dirname(path).replace(HOME, "~");
}

// --- formatting ------------------------------------------------------------

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function day(ms) {
  if (ms === null || ms === undefined) return "unknown";
  return new Date(ms).toISOString().slice(0, 10);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function padLeft(s, n) {
  s = String(s);
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many ?? one + "s"}`;
}

// --- the scan --------------------------------------------------------------

async function scan() {
  const roots = candidateRoots();
  if (roots.length === 0) {
    process.stdout.write(
      "\nLooked in the usual places and found no Claude folders on this Mac:\n" +
      "  ~/.claude/projects\n" +
      "  ~/Library/Application Support/Claude\n" +
      "  ~/Library/Application Support/Cowork\n\n" +
      "If your transcripts live somewhere else, point at it:\n" +
      `  node ${ME} --path=/where/they/are\n\n`,
    );
    return [];
  }

  process.stdout.write("\nSearching this Mac for Claude transcripts…\n");
  const paths = [];
  for (const r of roots) {
    const before = paths.length;
    walk(r.dir, 8, paths);
    process.stdout.write(
      `  ${pad(r.dir.replace(HOME, "~"), 58)} ${plural(paths.length - before, "file")}  (${r.what})\n`,
    );
  }

  const seen = new Set();
  const unique = paths.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  const transcripts = unique.filter(looksLikeTranscript);
  const notTranscripts = unique.length - transcripts.length;

  if (transcripts.length === 0) {
    process.stdout.write(
      `\nFound ${plural(unique.length, ".jsonl file")}, but none of them are Claude chats.\n` +
      "Nothing to send. Nothing left this machine.\n\n",
    );
    return [];
  }

  process.stdout.write(
    `\n${plural(transcripts.length, "transcript")} to look at` +
    (notTranscripts > 0 ? ` (skipped ${plural(notTranscripts, "other .jsonl file")})` : "") +
    (args.quick ? "" : ", reading them now…") + "\n",
  );

  const rows = [];
  for (const path of transcripts) {
    let st;
    try { st = statSync(path); } catch { continue; }
    const stats = args.quick
      ? { user: null, assistant: null, first: null, last: st.mtimeMs }
      : await readStats(path);
    rows.push({
      path,
      size: st.size,
      mtimeMs: st.mtimeMs,
      sessionId: sessionIdFor(path),
      project: projectLabelFor(path),
      messages: stats.user === null ? null : stats.user + stats.assistant,
      userMessages: stats.user,
      first: stats.first,
      last: stats.last ?? st.mtimeMs,
    });
  }
  return rows;
}

function applyFilters(rows) {
  const kept = [];
  const dropped = { thin: 0, dated: 0, named: 0, empty: 0 };
  for (const r of rows) {
    if (r.size === 0) { dropped.empty++; continue; }
    if (r.messages !== null && r.messages < MIN_MESSAGES) { dropped.thin++; continue; }
    const when = r.last ?? r.mtimeMs;
    if (SINCE !== null && when < SINCE) { dropped.dated++; continue; }
    if (UNTIL !== null && when > UNTIL) { dropped.dated++; continue; }
    const hay = (r.project + " " + r.path).toLowerCase();
    if (args.project.length && !args.project.some((p) => hay.includes(p.toLowerCase()))) { dropped.named++; continue; }
    if (args.exclude.length && args.exclude.some((p) => hay.includes(p.toLowerCase()))) { dropped.named++; continue; }
    kept.push(r);
  }
  // Newest first, so --limit=1 gives you the chat you most likely care about
  // and --limit=10 is a sensible first batch rather than an arbitrary ten.
  kept.sort((a, b) => (b.last ?? b.mtimeMs) - (a.last ?? a.mtimeMs));
  if (LIMIT !== null && kept.length > LIMIT) {
    const trimmed = kept.length - LIMIT;
    return { kept: kept.slice(0, LIMIT), dropped: { ...dropped, limited: trimmed } };
  }
  return { kept, dropped: { ...dropped, limited: 0 } };
}

function report(kept, dropped) {
  const byProject = new Map();
  for (const r of kept) {
    const g = byProject.get(r.project) ?? { files: 0, size: 0, messages: 0, first: null, last: null };
    g.files++;
    g.size += r.size;
    g.messages += r.messages ?? 0;
    const f = r.first ?? r.last;
    if (f !== null && (g.first === null || f < g.first)) g.first = f;
    if (r.last !== null && (g.last === null || r.last > g.last)) g.last = r.last;
    byProject.set(r.project, g);
  }

  const groups = [...byProject.entries()].sort((a, b) => b[1].size - a[1].size);
  const totalSize = kept.reduce((n, r) => n + r.size, 0);
  const totalMsgs = kept.reduce((n, r) => n + (r.messages ?? 0), 0);
  const oldest = kept.reduce((m, r) => (m === null || (r.first ?? r.last) < m ? (r.first ?? r.last) : m), null);
  const newest = kept.reduce((m, r) => (m === null || r.last > m ? r.last : m), null);

  process.stdout.write("\n" + "-".repeat(94) + "\n");
  process.stdout.write(`${pad("WHAT'S ON THIS MACHINE", 46)}${padLeft("chats", 7)}${padLeft("messages", 10)}${padLeft("size", 9)}   first … last\n`);
  process.stdout.write("-".repeat(94) + "\n");
  for (const [name, g] of groups) {
    process.stdout.write(
      pad(name, 46) + padLeft(g.files, 7) + padLeft(args.quick ? "?" : g.messages, 10) +
      padLeft(human(g.size), 9) + "   " + day(g.first) + " … " + day(g.last) + "\n",
    );
  }
  process.stdout.write("-".repeat(94) + "\n");
  process.stdout.write(
    pad(`${plural(groups.length, "project")}`, 46) + padLeft(kept.length, 7) +
    padLeft(args.quick ? "?" : totalMsgs, 10) + padLeft(human(totalSize), 9) +
    "   " + day(oldest) + " … " + day(newest) + "\n\n",
  );

  if (args.list) {
    for (const r of kept.slice().sort((a, b) => (a.last ?? 0) - (b.last ?? 0))) {
      process.stdout.write(
        `  ${day(r.last)}  ${padLeft(human(r.size), 8)}  ${padLeft(r.messages ?? "?", 5)} msg  ${r.path.replace(HOME, "~")}\n`,
      );
    }
    process.stdout.write("\n");
  }

  const skipped = dropped.thin + dropped.dated + dropped.named + dropped.empty + (dropped.limited ?? 0);
  if (skipped > 0) {
    const bits = [];
    if (dropped.thin) bits.push(`${dropped.thin} too short (under ${MIN_MESSAGES} messages)`);
    if (dropped.dated) bits.push(`${dropped.dated} outside your date range`);
    if (dropped.named) bits.push(`${dropped.named} filtered out by name`);
    if (dropped.empty) bits.push(`${dropped.empty} empty`);
    if (dropped.limited) bits.push(`${dropped.limited} beyond your --limit of ${LIMIT}`);
    process.stdout.write(`Left out: ${bits.join(", ")}.\n\n`);
  }
}

// --- auth ------------------------------------------------------------------
//
// The connector already logged you in and cached the token under ~/.mcp-auth.
// Reuse it rather than asking anyone to paste a secret around. The version
// directory tracks mcp-remote's internal version, so glob it — never hardcode.

function cachedToken() {
  try {
    const authBase = join(HOME, ".mcp-auth");
    let best = null, bestMtime = -1;
    for (const d of readdirSync(authBase)) {
      if (!d.startsWith("mcp-remote-")) continue;
      let files;
      try { files = readdirSync(join(authBase, d)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith("_tokens.json")) continue;
        const p = join(authBase, d, f);
        try {
          const mt = statSync(p).mtimeMs;
          if (mt > bestMtime) { bestMtime = mt; best = p; }
        } catch {}
      }
    }
    if (!best) return null;
    const parsed = JSON.parse(readFileSync(best, "utf8"));
    return typeof parsed?.access_token === "string" && parsed.access_token
      ? { token: parsed.access_token, from: best.replace(HOME, "~") }
      : null;
  } catch {
    return null;
  }
}

// A 401 tells you nothing about WHY, and the two sources fail for completely
// different reasons: a cached connector login expires on its own after about a
// month, while a minted token is either in the server's table or it isn't. So
// describe what we're actually holding — enough to spot a truncated paste, a
// stray quote, or a literal "..." — without ever printing the secret.
function tokenShape(tok) {
  if (/^[0-9a-f]{64}$/i.test(tok)) return "a 64-character minted token, which is the right shape";
  if (tok.split(".").length === 3) return "a login token (JWT)";
  return `${tok.length} characters, which is NOT the shape of either a minted token (64 hex) or a login token`;
}

function tokenHint(tok) {
  const bits = [`  What you sent: ${tokenShape(tok)}`];
  if (tok.length >= 8) bits.push(`  It starts ${tok.slice(0, 4)}… and ends …${tok.slice(-4)}`);
  if (/["']/.test(tok)) bits.push("  It contains a quote character — you may have pasted the quotes too.");
  if (/\s/.test(tok)) bits.push("  It contains a space or newline in the middle.");
  if (tok.includes("...") || tok.includes("\u2026")) bits.push("  It contains \"...\" — that was a placeholder, not the token.");
  return bits.join("\n");
}

// Things people export when they copy an instruction verbatim. None of them is
// a credential, and treating one as "the user explicitly chose this" is how a
// stale env var silently shadows a sign-in that just succeeded.
const PLACEHOLDERS = /^(\.{2,}|\u2026|<.*>|\[.*\]|paste[-_ ]?it[-_ ]?here|your[-_ ]?token|token|xxx+|tbd|none|null|undefined)$/i;

function resolveToken() {
  const env = String(process.env.VG_BRAIN_TOKEN || "").trim();
  const saved = savedLogin();
  const cached = cachedToken();

  if (env && !PLACEHOLDERS.test(env)) {
    // An explicitly set token wins, but say so when it is standing in front of
    // a sign-in — otherwise a rejection looks like the sign-in failed.
    if (saved) {
      process.stdout.write(
        "Note: VG_BRAIN_TOKEN is set, so it's being used instead of the sign-in saved\n" +
        `on this Mac. Run  unset VG_BRAIN_TOKEN  to use the sign-in instead.\n\n`,
      );
    }
    return { token: env, from: "the VG_BRAIN_TOKEN environment variable", minted: true };
  }
  if (env) {
    process.stdout.write(
      `Ignoring VG_BRAIN_TOKEN — it's set to ${JSON.stringify(env)}, which is a\n` +
      "placeholder, not a token. Clear it with  unset VG_BRAIN_TOKEN  to stop this notice.\n\n",
    );
  }
  if (saved) return saved;
  return cached ? { ...cached, minted: false } : null;
}

// --- http ------------------------------------------------------------------

// --- signing in ------------------------------------------------------------
//
// The whole point is that nobody has to be handed a secret. VG Brain speaks
// OAuth 2.1 with dynamic client registration and PKCE, so this script can
// register itself, bounce you through your own browser, and catch the
// authorization code on a loopback port. Same handshake the connector does.
// Nothing is emailed, nothing is pasted, and the operator is not involved.

const LOGIN_FILE = join(HOME, ".vg-brain-backfill.json");

function savedLogin() {
  try {
    const j = JSON.parse(readFileSync(LOGIN_FILE, "utf8"));
    if (typeof j?.access_token !== "string" || !j.access_token) return null;
    if (j.base && j.base !== BASE) return null; // a login for a different server
    if (typeof j.expires_at === "number" && Date.now() > j.expires_at) return null;
    return { token: j.access_token, from: `your saved sign-in (${LOGIN_FILE.replace(HOME, "~")})`, minted: false };
  } catch {
    return null;
  }
}

function saveLogin(token, expiresIn) {
  try {
    writeFileSync(LOGIN_FILE, JSON.stringify({
      base: BASE,
      access_token: token,
      expires_at: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null,
      saved_at: new Date().toISOString(),
    }, null, 2));
    chmodSync(LOGIN_FILE, 0o600);
    return true;
  } catch {
    return false;
  }
}

function postForm(url, fields) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ status: 0, error: "bad url" }); return; }
    const payload = Buffer.from(new URLSearchParams(fields).toString(), "utf8");
    const lib = u.protocol === "http:" ? httpRequest : httpsRequest;
    const req = lib(u, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": payload.length,
        Accept: "application/json",
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on("error", (e) => resolve({ status: 0, error: e?.message ?? String(e) }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, error: "timed out" }); });
    req.write(payload);
    req.end();
  });
}

function postJson(url, obj) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ status: 0, error: "bad url" }); return; }
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    const lib = u.protocol === "http:" ? httpRequest : httpsRequest;
    const req = lib(u, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": payload.length, Accept: "application/json" },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on("error", (e) => resolve({ status: 0, error: e?.message ?? String(e) }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, error: "timed out" }); });
    req.write(payload);
    req.end();
  });
}

function openInBrowser(url) {
  if (process.env.VG_BRAIN_NO_BROWSER) return false; // tests, and headless boxes
  try {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    // No listener here and a missing opener takes the whole script down with an
    // unhandled 'error' event — after it has already told you to check your
    // browser. Swallow it; the URL is printed either way.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// Waits for the browser to come back to us with ?code=. Resolves once, and
// always shows the person something in the tab rather than a dead connection.
function awaitCallback(server, state) {
  return new Promise((resolve) => {
    let settled = false;
    // The give-up timer has to be cleared, not just ignored. A pending timeout
    // keeps Node's event loop alive, so without this the script sits there for
    // five minutes AFTER telling you it signed you in successfully.
    let giveUp = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (giveUp) clearTimeout(giveUp);
      resolve(v);
    };
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get("code");
      const got = u.searchParams.get("state");
      const err = u.searchParams.get("error");
      const page = (title, body) =>
        `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
        `<body style="font:16px -apple-system,system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 1.5em;color:#172D36">` +
        `<h2 style="font-weight:600">${title}</h2><p>${body}</p></body>`;
      if (err) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("Sign-in failed", `The server said: <code>${err}</code>. You can close this tab.`));
        finish({ error: err });
        return;
      }
      if (!code || got !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("Sign-in failed", "Something didn't line up. Close this tab and run the command again."));
        finish({ error: got !== state ? "state mismatch" : "no code returned" });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(page("You're signed in \u{1F9E0}", "Close this tab and go back to your Terminal."));
      finish({ code });
    });
    giveUp = setTimeout(() => finish({ error: "nobody finished signing in within 5 minutes" }), 5 * 60 * 1000);
  });
}

async function login() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = sha256("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    // Register as a PUBLIC client — no secret to store, nothing to leak.
    const reg = await postJson(`${BASE}/oauth/register`, {
      client_name: "VG Brain transcript backfill",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    });
    if (reg.status !== 200 && reg.status !== 201) {
      die(
        `could not start the sign-in with ${BASE} (${reg.status || "no response"}).` +
        `${errText(reg.body) ? `\n  The server said: "${errText(reg.body)}"` : ""}` +
        "\n  Nothing was uploaded.",
      );
    }
    const clientId = reg.body?.client_id;
    if (!clientId) die("the server didn't give this script an identity to sign in with. Nothing was uploaded.");

    const authUrl = `${BASE}/oauth/authorize?` + new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    process.stdout.write(
      "\nOpening your browser so you can sign in to VG Brain.\n" +
      "Use the same account you use for everything else.\n\n",
    );
    if (!openInBrowser(authUrl)) {
      process.stdout.write("Couldn't open it for you. Paste this into your browser:\n\n");
    }
    process.stdout.write(
      `  ${authUrl}\n\nWaiting…\n` +
      "(If the browser shows a Google error instead of a sign-in box, stop here and\n" +
      " send Liam what it says — that's a server setting, not anything you did.)\n",
    );

    const back = await awaitCallback(server, state);
    if (back.error) die(`sign-in didn't finish (${back.error}). Nothing was uploaded.`);

    const tok = await postForm(`${BASE}/oauth/token`, {
      grant_type: "authorization_code",
      code: back.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    if (tok.status !== 200 || !tok.body?.access_token) {
      die(
        `the sign-in was accepted but the token step failed (${tok.status || "no response"}).` +
        `${errText(tok.body) ? `\n  The server said: "${errText(tok.body)}"` : ""}` +
        "\n  Nothing was uploaded.",
      );
    }

    const kept = saveLogin(tok.body.access_token, Number(tok.body.expires_in));
    process.stdout.write(
      `\nSigned in.${kept ? ` Saved to ${LOGIN_FILE.replace(HOME, "~")} so you won't have to do this again.` : ""}\n\n`,
    );
    return { token: tok.body.access_token, from: "the sign-in you just did", minted: false };
  } finally {
    // close() alone waits for the browser's keep-alive socket to time out.
    server.closeAllConnections?.();
    server.close();
  }
}


function httpJson(method, url, token, bodyObj) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ status: 0, error: "bad url" }); return; }
    const headers = { Authorization: "Bearer " + token, Accept: "application/json" };
    let payload = null;
    if (bodyObj !== undefined) {
      const json = Buffer.from(JSON.stringify(bodyObj), "utf8");
      try {
        payload = gzipSync(json);
        headers["Content-Encoding"] = "gzip";
      } catch {
        payload = json;
      }
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = payload.length;
    }
    const lib = u.protocol === "http:" ? httpRequest : httpsRequest;
    const req = lib(u, { method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on("error", (e) => resolve({ status: 0, error: e?.message ?? String(e) }));
    req.setTimeout(180000, () => { req.destroy(); resolve({ status: 0, error: "timed out" }); });
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


// Servers answer with error strings, {message}, {error:{message}}, or an
// object with no obvious field. Printing "[object Object]" at somebody who is
// already stuck is worse than printing nothing.
function errText(body) {
  const pick = (v) => {
    if (typeof v === "string") return v.trim();
    if (v && typeof v === "object") {
      for (const k of ["error_description", "message", "error", "detail", "reason"]) {
        const got = pick(v[k]);
        if (got) return got;
      }
      try { const j = JSON.stringify(v); if (j && j !== "{}") return j.slice(0, 200); } catch {}
    }
    return "";
  };
  return pick(body);
}

function rejectedMessage(auth, probe) {
  const said = errText(probe.body) ? `\n  The server said: "${errText(probe.body)}"` : "";
  const head =
    `the server rejected that login (${probe.status}).\n` +
    `  It came from ${auth.from}.${said}\n` +
    tokenHint(auth.token) + "\n";
  const fix = auth.minted
    ? "\n  That token came from VG_BRAIN_TOKEN, which you set by hand. A minted token\n" +
      "  is either in the server's table or it isn't — it doesn't expire on a clock,\n" +
      "  so a rejection means it's the wrong string or it was never really minted.\n" +
      "  You don't need one. Sign in as yourself instead:\n" +
      `    unset VG_BRAIN_TOKEN\n    node ${ME} --login\n`
    : "\n  Logins expire after about a month and don't renew themselves. Sign in again:\n" +
      `    node ${ME} --login\n`;
  return head + fix + "\n  Nothing was uploaded.";
}

// Answers the question you actually have when a 401 shows up: does this login
// work, and who does the server think I am? Worth running before committing to
// a big upload — a token minted against the wrong tenant does NOT 401, it just
// files everything somewhere you'll never look.
async function whoami(pre) {
  // Take the sign-in we were just handed rather than going back to the
  // resolver — otherwise a leftover env var shadows the login of five seconds
  // ago and reports it as a failure.
  const auth = pre ?? resolveToken();
  if (!auth) {
    die(`no login found on this Mac. Run:  node ${ME} --login`);
  }
  process.stdout.write(`\nChecking ${BASE}\n  Login from ${auth.from}\n  ${tokenShape(auth.token)}\n\n`);
  const r = await httpJson("GET", `${BASE}/context-header?source=whoami`, auth.token);
  if (r.status === 401 || r.status === 403) {
    die(rejectedMessage(auth, r));
  }
  if (r.status !== 200) {
    die(`${BASE} answered ${r.status || "nothing"}${r.error ? ` (${r.error})` : ""}. Nothing was uploaded.`);
  }
  const header = String(r.body?.header ?? "");
  const lines = header.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 12);
  process.stdout.write("Your login works. Here is how the brain greets you — check that this is\nYOUR brain and not an empty one before you upload anything:\n\n");
  for (const l of lines) process.stdout.write(`  ${l}\n`);
  process.stdout.write(`\n  (${header.length} characters of context in total)\n\n`);
}

// --- the send --------------------------------------------------------------

// A transcript goes up in pieces. /ingest caps a request body and the biggest
// chats here run past 80MB, so anything over CHUNK_BYTES is uploaded as a
// sequence: the first piece creates the row, each later one is a
// compare-and-swap append at the byte offset the server says it has. The
// server concatenates them, so the row ends up byte-identical to the file.
// Overridable so the tests can exercise the multi-piece path without
// generating a 17MB fixture.
const CHUNK_BYTES = Math.max(1024, Number(process.env.VG_BRAIN_CHUNK_BYTES) || 16 * 1024 * 1024);

// Where to end a chunk that is NOT the end of the file.
//
// Two things must hold. The pieces have to concatenate back into the original
// file byte for byte — that is what makes the server's row equal the transcript
// — and each piece has to survive Buffer.toString("utf8") on its own, because
// that is how it goes into JSON. Cutting in the middle of a multi-byte
// character turns both halves into U+FFFD and nothing downstream would ever
// flag it. So: prefer a newline (JSONL hands us one every couple hundred
// bytes), and when a single line is longer than a whole chunk, fall back to the
// last complete character.
function utf8Boundary(buf) {
  let i = buf.length - 1;
  let steps = 0;
  while (i >= 0 && (buf[i] & 0xc0) === 0x80 && steps < 3) { i--; steps++; }
  if (i < 0) return buf.length;
  const lead = buf[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  // The final sequence is complete — keep everything. Otherwise stop before it
  // and let the next chunk carry the whole character.
  return buf.length - i >= need ? buf.length : i;
}

function cutAt(buf) {
  const nl = buf.lastIndexOf(0x0a);
  // Ignore a newline so early in the window that honouring it would shrink the
  // chunk to nothing and turn one upload into hundreds.
  if (nl >= 0 && nl + 1 >= buf.length / 2) return nl + 1;
  return utf8Boundary(buf);
}

function readRange(path, from, len) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const got = readSync(fd, buf, 0, len, from);
    return buf.slice(0, got);
  } finally {
    closeSync(fd);
  }
}

// Which kind of session this file came from, because the server routes on it.
//
// A "claude-code-*" source is WALLED to people/<you>/dev — a sealed leaf for
// infra and secrets, excluded from the shareable zone entirely. That is right
// for an actual Claude Code session and wrong for everything else: a Cowork
// chat about a client's forecast is ordinary work and belongs in the ordinary
// private zone, people/<you>, where you can find it and share it if you choose.
// Both are private to you; the dev wall is an extra seal, not the privacy.
function sourceFor(path) {
  if (/local-agent-mode-sessions/.test(path)) return "cowork-backfill-script";
  if (/[\\/]local_[0-9a-f-]{36}([\\/]|$)/i.test(path)) return "cowork-backfill-script";
  if (/[\\/]\.claude[\\/]projects[\\/]/.test(path)) return "claude-code-backfill-script";
  return "cowork-backfill-script";
}

async function sendOne(r, held, token, label) {
  const meta = { transcript_path: r.path, hook_event_name: "Backfill", backfill: true };
  const common = { reason: "backfill", source: sourceFor(r.path), meta };

  let at = held;
  let wrote = 0;
  let retriedFull = false;
  const pieces = Math.ceil((r.size - held) / CHUNK_BYTES);
  let piece = 0;

  while (at < r.size) {
    piece++;
    let buf;
    try {
      const remaining = r.size - at;
      const take = Math.min(CHUNK_BYTES, remaining);
      const window = readRange(r.path, at, take);
      // Only trim when there is more file after this window; the last piece
      // ends where the file ends.
      buf = take < remaining ? window.slice(0, cutAt(window)) : window;
    } catch (e) {
      process.stdout.write(`${label} could not read the file\n`);
      return { ok: false, why: `could not read it (${e?.message ?? e})` };
    }
    if (buf.length === 0) break;

    const body = at === 0
      ? { ...common, session_id: r.sessionId, transcript: buf.toString("utf8") }
      : { ...common, session_id: r.sessionId, append: true, from_bytes: at, transcript: buf.toString("utf8") };

    let resp = await httpJson("POST", `${BASE}/ingest`, token, body);

    if (resp.status === 429) {
      process.stdout.write(`${label} server asked us to slow down — waiting 30s\n`);
      await sleep(30000);
      resp = await httpJson("POST", `${BASE}/ingest`, token, body);
    }

    // The cursor moved under us (row purged, or another device sent some).
    // Start the whole file over as a fresh upload, once.
    if (resp.status === 409 && resp.body?.resend === "full" && !retriedFull) {
      retriedFull = true;
      at = 0;
      wrote = 0;
      piece = 0;
      continue;
    }

    if (resp.status === 401) {
      die("the server rejected your login (401) partway through. Reconnect VG Brain in Claude, or get a fresh token, then run this again — nothing you already sent will be sent twice.");
    }

    const okStatus = resp.status === 200 || resp.status === 201 || resp.status === 202;
    if (!okStatus) {
      const why = resp.error ?? resp.body?.error ?? `HTTP ${resp.status}`;
      process.stdout.write(`${label} FAILED — ${why}\n`);
      return { ok: false, why };
    }
    // A 202 with staged:false means the server took the request but is not
    // accepting chats right now. That is not a success and must not read
    // like one.
    if (resp.body && resp.body.staged === false) {
      const why = resp.body.reason ?? "the server declined it";
      process.stdout.write(`${label} NOT stored — ${why}\n`);
      return { ok: false, refused: true, why };
    }

    at += buf.length;
    wrote += buf.length;
    if (pieces > 1) {
      process.stdout.write(`${label} ${padLeft(human(wrote), 8)} of ${human(r.size - held)}\r`);
      await sleep(250);
    }
  }

  const tail = pieces > 1 ? `  (in ${piece} pieces)` : held > 0 ? "  (the rest of it)" : "";
  process.stdout.write(`${label} sent  ${pad(human(wrote), 9)}${tail}\n`);
  return { ok: true, bytes: wrote };
}


async function send(kept) {
  let auth = preAuth ?? resolveToken();
  if (!auth) {
    // Don't send anyone away to fetch a credential — just sign them in.
    if (process.stdin.isTTY) {
      process.stdout.write("\nYou're not signed in to VG Brain on this Mac yet. Let's fix that first.\n");
      auth = await login();
    } else {
      die(
        "you're not signed in to VG Brain on this Mac, so there's nothing to send with.\n" +
        `  Run:  node ${ME} --login\n` +
        "  Nothing was uploaded.",
      );
    }
  }

  // Check the login BEFORE asking anyone to commit to a 1GB upload. The cached
  // connector token is ~30 days with no refresh, so an expired one is the
  // normal case, not an edge case — finding that out after "yes" is a waste of
  // their time.
  const probe = await httpJson(
    "GET", `${BASE}/ingest/cursor?session_id=auth-probe-0000`, auth.token,
  );
  if (probe.status === 401 || probe.status === 403) {
    die(rejectedMessage(auth, probe));
  }
  if (probe.status === 0) {
    die(`could not reach ${BASE} (${probe.error ?? "no response"}). Nothing was uploaded.`);
  }

  const totalSize = kept.reduce((n, r) => n + r.size, 0);
  process.stdout.write(
    `About to send ${plural(kept.length, "chat")} (${human(totalSize)}) to ${BASE}.\n` +
    `Signed in from ${auth.from}.\n\n` +
    "These become notes in YOUR OWN brain. Nobody else can read them unless you\n" +
    "share a note later. Chats the brain already has are skipped.\n\n",
  );

  // A big pile is worth a second thought: every chat gets read by a model on
  // the server, so a thousand-chat run is real time and real money, and it
  // lands as a lot of notes at once. Say so rather than letting somebody find
  // out afterwards.
  if (kept.length > 50 || totalSize > 200 * 1024 * 1024) {
    process.stdout.write(
      "That's a lot at once. The brain reads every one of these to work out what's\n" +
      "worth keeping, so a pile this size takes a while and lands as a lot of notes.\n" +
      "You can do it in batches instead — this is safe to run over and over, and it\n" +
      "skips whatever already went:\n" +
      `  node ${ME} --since=2026-07-01 --send\n\n`,
    );
  }

  if (!args.yes) {
    // No keyboard attached (piped, cron, a CI runner) — there is nobody to say
    // yes, so stop rather than hang or assume consent.
    if (!process.stdin.isTTY) {
      die("this isn't an interactive terminal, so I can't ask you to confirm.\n  Re-run with --yes if you're sure. Nothing was uploaded.");
    }
    const rl = createPrompt({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Type 'yes' to send, anything else to stop: ")).trim().toLowerCase();
    rl.close();
    if (answer !== "yes") {
      process.stdout.write("\nStopped. Nothing left this machine.\n\n");
      return;
    }
    process.stdout.write("\n");
  }

  let sent = 0, skipped = 0, failed = 0, bytesSent = 0, refused = 0, refusedRun = 0;
  const problems = [];
  let n = 0;

  for (const r of kept) {
    n++;
    const label = `[${padLeft(n, String(kept.length).length)}/${kept.length}] ${pad(basename(r.path), 42)}`;

    // The server may already hold some or all of this chat (it's append-only,
    // so it tracks how many bytes it has). Send only what's missing.
    const cur = await httpJson("GET", `${BASE}/ingest/cursor?session_id=${encodeURIComponent(r.sessionId)}`, auth.token);
    if (cur.status === 401) {
      die("the server rejected your login (401). Reconnect VG Brain in Claude, or get a fresh token, then run this again.");
    }
    let held = cur.status === 200 && typeof cur.body?.bytes === "number" ? cur.body.bytes : 0;

    if (held >= r.size && held > 0) {
      skipped++;
      process.stdout.write(`${label} already on the brain\n`);
      continue;
    }

    const outcome = await sendOne(r, held, auth.token, label);
    if (outcome.ok) {
      sent++;
      bytesSent += outcome.bytes;
      refusedRun = 0;
    } else if (outcome.refused) {
      refused++;
      refusedRun++;
      problems.push(`${basename(r.path)}: not stored (${outcome.why})`);
      // The server isn't taking chats. It will not start taking them on the
      // 200th try, and grinding through the rest just buries the reason under
      // a wall of identical lines.
      if (refusedRun >= 3 && n < kept.length) {
        process.stdout.write(
          `\nStopping — the server has turned away ${refusedRun} in a row, so it isn't\n` +
          `accepting chats right now. ${kept.length - n} left untried.\n`,
        );
        break;
      }
    } else {
      failed++;
      refusedRun = 0;
      problems.push(`${basename(r.path)}: ${outcome.why}`);
    }

    if (n < kept.length) await sleep(DELAY_MS);
  }

  process.stdout.write("\n" + "-".repeat(70) + "\n");
  process.stdout.write(
    `Sent ${plural(sent, "chat")} (${human(bytesSent)}). ` +
    `${skipped} already there. ${refused} refused. ${failed} failed.\n`,
  );
  if (problems.length) {
    process.stdout.write("\nWhat went wrong:\n");
    for (const p of problems.slice(0, 20)) process.stdout.write(`  ${p}\n`);
    if (problems.length > 20) process.stdout.write(`  …and ${problems.length - 20} more\n`);
  }
  if (refused > 0) {
    process.stdout.write(
      "\n'capture-disabled' means VG Brain isn't accepting chats at the moment.\n" +
      "Tell Liam — it's a server switch, not anything you did. Re-run this after\n" +
      "he flips it; the chats that did go through won't be sent twice.\n",
    );
  }
  if (sent > 0) {
    process.stdout.write(
      "\nThe brain reads these on its own schedule (a couple of hours at most) and\n" +
      `files what's worth keeping into your notes. Check ${BASE}/notes later today.\n` +
      "Running this again is safe — it won't duplicate anything.\n",
    );
  }
  process.stdout.write("\n");
}

// --- main ------------------------------------------------------------------

async function main() {
  // A one-shot `--send` is the whole job in one command: sign in, look, confirm,
  // upload. Do the sign-in FIRST so the browser opens straight away — scanning a
  // few hundred transcripts takes a minute, and a minute of silence before the
  // login prompt reads like a hang.
  if (args.send && !args.whoami && !args.login && !args.logout && !resolveToken() && process.stdin.isTTY) {
    process.stdout.write("\nFirst, sign in to VG Brain.\n");
    preAuth = await login();
  }

  if (args.logout) {
    try { unlinkSync(LOGIN_FILE); process.stdout.write("\nSigned out on this Mac.\n\n"); }
    catch { process.stdout.write("\nThere was no saved sign-in to forget.\n\n"); }
    return;
  }

  if (args.login) {
    const fresh = await login();
    await whoami(fresh);
    return;
  }

  if (args.whoami) {
    await whoami();
    return;
  }

  const rows = await scan();
  if (rows.length === 0) return;

  const { kept, dropped } = applyFilters(rows);

  if (args.json) {
    process.stdout.write(JSON.stringify({ base: BASE, kept, dropped }, null, 2) + "\n");
    return;
  }

  report(kept, dropped);

  if (kept.length === 0) {
    process.stdout.write("Nothing left after your filters. Nothing was sent.\n\n");
    return;
  }

  if (!args.send) {
    process.stdout.write(
      "Nothing has been sent. This was a look, not an upload.\n\n" +
      "When it looks right:\n" +
      `  node ${ME} --send\n\n` +
      "To narrow it down first:\n" +
      `  node ${ME} --list\n` +
      `  node ${ME} --limit=1 --send        # try one first\n` +
      `  node ${ME} --since=2025-06-01\n` +
      `  node ${ME} --project=acme --send\n` +
      `  node ${ME} --exclude=scratch --send\n\n`,
    );
    return;
  }

  await send(kept);
}

main().catch((err) => {
  process.stderr.write(`\nvg-brain-backfill: ${err?.stack ?? err}\n\n`);
  process.exit(1);
});
