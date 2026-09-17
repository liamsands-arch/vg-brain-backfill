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
 *   --path=/some/dir       also search here
 *   --quick                skip reading the files (sizes and dates only)
 *   --json                 machine-readable scan output
 *   --yes                  don't ask before uploading
 *   --delay-ms=750         pause between uploads
 *
 * Auth, when you --send: the script reuses the VG Brain login already cached on
 * this Mac by the connector (~/.mcp-auth). If there isn't one, set a token that
 * Liam mints for you:  export VG_BRAIN_TOKEN=...
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
import { request as httpRequest } from "node:http";

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
const HOME = homedir();
const BASE = String(process.env.VG_BRAIN_URL || "https://vg-brain.fly.dev").replace(/\/+$/, "");
const MIN_MESSAGES = args["min-messages"] === undefined ? 4 : Number(args["min-messages"]);
const DELAY_MS = args["delay-ms"] === undefined ? 750 : Number(args["delay-ms"]);
const SINCE = args.since ? Date.parse(args.since + "T00:00:00Z") : null;
const UNTIL = args.until ? Date.parse(args.until + "T23:59:59Z") : null;

if (Number.isNaN(MIN_MESSAGES)) die("--min-messages needs a number");
if (Number.isNaN(DELAY_MS)) die("--delay-ms needs a number");
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
  const parts = path.split(sep);
  const i = parts.lastIndexOf("projects");
  if (i >= 0 && parts.length > i + 1) {
    const slug = parts[i + 1];
    const tail = slug.split("-").filter(Boolean).pop();
    return tail ? `${tail}  (${slug})` : slug;
  }
  // Cowork kept each local agent session in its own local_<uuid> folder. The
  // uuid means nothing to a human, so group them all under one heading rather
  // than printing a hundred rows of hex.
  if (/local-agent-mode-sessions/.test(path)) return "Cowork  (local sessions)";
  if (/[\\/]local_[0-9a-f-]{36}[\\/]/i.test(path)) return "Cowork  (local sessions)";
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
  return { kept, dropped };
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

  const skipped = dropped.thin + dropped.dated + dropped.named + dropped.empty;
  if (skipped > 0) {
    const bits = [];
    if (dropped.thin) bits.push(`${dropped.thin} too short (under ${MIN_MESSAGES} messages)`);
    if (dropped.dated) bits.push(`${dropped.dated} outside your date range`);
    if (dropped.named) bits.push(`${dropped.named} filtered out by name`);
    if (dropped.empty) bits.push(`${dropped.empty} empty`);
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

function resolveToken() {
  const env = String(process.env.VG_BRAIN_TOKEN || "").trim();
  if (env) return { token: env, from: "the VG_BRAIN_TOKEN environment variable" };
  return cachedToken();
}

// --- http ------------------------------------------------------------------

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

// --- the send --------------------------------------------------------------

async function send(kept) {
  const auth = resolveToken();
  if (!auth) {
    die(
      "you're not signed in to VG Brain on this Mac, so there's nothing to send with.\n" +
      "  Either connect VG Brain in Claude once (that caches a login under ~/.mcp-auth),\n" +
      "  or ask Liam for a token and run:  export VG_BRAIN_TOKEN=...  then try again.\n" +
      "  Nothing was uploaded.",
    );
  }

  const totalSize = kept.reduce((n, r) => n + r.size, 0);
  process.stdout.write(
    `About to send ${plural(kept.length, "chat")} (${human(totalSize)}) to ${BASE}.\n` +
    `Signed in from ${auth.from}.\n\n` +
    "These become notes in YOUR OWN brain. Nobody else can read them unless you\n" +
    "share a note later. Chats the brain already has are skipped.\n\n",
  );

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

  let sent = 0, skipped = 0, failed = 0, bytesSent = 0, refused = 0;
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
    const held = cur.status === 200 && typeof cur.body?.bytes === "number" ? cur.body.bytes : 0;

    if (held >= r.size && held > 0) {
      skipped++;
      process.stdout.write(`${label} already on the brain\n`);
      continue;
    }

    let body;
    try {
      if (held > 0 && held < r.size) {
        const fd = openSync(r.path, "r");
        try {
          const buf = Buffer.alloc(r.size - held);
          const got = readSync(fd, buf, 0, r.size - held, held);
          body = {
            session_id: r.sessionId,
            append: true,
            from_bytes: held,
            transcript: buf.slice(0, got).toString("utf8"),
          };
        } finally { closeSync(fd); }
      } else {
        body = { session_id: r.sessionId, transcript: readFileSync(r.path, "utf8") };
      }
    } catch (e) {
      failed++;
      problems.push(`${r.path}: could not read it (${e?.message ?? e})`);
      process.stdout.write(`${label} could not read the file\n`);
      continue;
    }

    body.reason = "backfill";
    // "claude-code-*" tells the server this came from a dev-side install, which
    // is what walls the resulting notes to your own private zone.
    body.source = "claude-code-backfill-script";
    body.meta = { transcript_path: r.path, hook_event_name: "Backfill", backfill: true };

    let resp = await httpJson("POST", `${BASE}/ingest`, auth.token, body);

    // The cursor moved under us (the row was purged, or another device sent
    // some). Start over with the whole file, once.
    if (resp.status === 409 && resp.body?.resend === "full") {
      try {
        resp = await httpJson("POST", `${BASE}/ingest`, auth.token, {
          ...body, append: undefined, from_bytes: undefined, transcript: readFileSync(r.path, "utf8"),
        });
      } catch {}
    }

    if (resp.status === 429) {
      process.stdout.write(`${label} server asked us to slow down — waiting 30s\n`);
      await sleep(30000);
      resp = await httpJson("POST", `${BASE}/ingest`, auth.token, body);
    }

    if (resp.status === 200 || resp.status === 201 || resp.status === 202) {
      // A 202 with staged:false means the server took the request but is not
      // accepting chats right now. That is not a success and must not read
      // like one.
      if (resp.body && resp.body.staged === false) {
        refused++;
        const why = resp.body.reason ?? "the server declined it";
        process.stdout.write(`${label} NOT stored — ${why}\n`);
        problems.push(`${basename(r.path)}: not stored (${why})`);
      } else {
        sent++;
        const wire = r.size - Math.min(held, r.size);
        bytesSent += wire;
        process.stdout.write(`${label} sent  ${human(wire)}${held > 0 ? " (the rest of it)" : ""}\n`);
      }
    } else {
      failed++;
      const why = resp.error ?? resp.body?.error ?? `HTTP ${resp.status}`;
      process.stdout.write(`${label} FAILED — ${why}\n`);
      problems.push(`${basename(r.path)}: ${why}`);
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
