#!/usr/bin/env node
// Scan-only test: builds a fake HOME with Claude Code and Cowork transcripts,
// runs backfill.mjs against it without --send, and checks what it would keep.
// Never touches the network.
//
//   node test/scan.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "backfill.mjs");
const home = mkdtempSync(join(tmpdir(), "vg-backfill-test-"));

// A chat with enough turns to clear the default --min-messages=4.
function chat(turns = 6) {
  const lines = [];
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({
      type: i % 2 ? "assistant" : "user",
      message: { role: i % 2 ? "assistant" : "user", content: `turn ${i}` },
      timestamp: new Date(Date.UTC(2026, 5, 1, 12, i)).toISOString(),
    }));
  }
  return lines.join("\n") + "\n";
}
const notAChat = JSON.stringify({ level: "info", msg: "telemetry" }) + "\n";

function put(rel, body) {
  const p = join(home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
}

const uuid = (n) => `${String(n).repeat(8)}-1111-4111-8111-${String(n).repeat(12)}`;
const sessions = "Library/Application Support/Claude/local-agent-mode-sessions/acct/org";
const inner = (n) => `${sessions}/local_${uuid(n)}/.claude/projects/-sessions-outputs/${uuid(n + 4)}.jsonl`;

// Plain Claude Code session.
put(`.claude/projects/-Users-sam-code-acme/${uuid(9)}.jsonl`, chat());
// Cowork session 1: audit.jsonl + real transcript  -> audit is a duplicate
put(`${sessions}/local_${uuid(1)}/audit.jsonl`, chat());
put(inner(1), chat());
// Cowork session 2: only audit.jsonl               -> keep it
put(`${sessions}/local_${uuid(2)}/audit.jsonl`, chat());
// Cowork session 3: audit.jsonl + a non-chat .jsonl -> keep audit (no other chat)
put(`${sessions}/local_${uuid(3)}/audit.jsonl`, chat());
put(`${sessions}/local_${uuid(3)}/.claude/projects/-sessions-outputs/telemetry.jsonl`, notAChat);
// Cowork session 4: same as 1                       -> audit is a duplicate
put(`${sessions}/local_${uuid(4)}/audit.jsonl`, chat());
put(inner(4), chat());

function run(flags, env = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...flags], {
    env: { ...process.env, HOME: home, VG_BACKFILL_LAUNCHER: "", VG_BRAIN_TOKEN: "", ...env },
    encoding: "utf8",
  });
}

// --json still prints the "Searching…" progress lines first; the JSON is the
// block that starts at the first line reading "{".
function runJson(flags) {
  const out = run(flags);
  const at = out.indexOf("\n{\n");
  return JSON.parse(at >= 0 ? out.slice(at + 1) : out);
}

let failed = false;
function check(name, fn) {
  try { fn(); process.stdout.write(`ok    ${name}\n`); }
  catch (e) { failed = true; process.stdout.write(`FAIL  ${name}\n${e.message}\n`); }
}

try {
  const out = runJson(["--json"]);
  const keptRel = out.kept.map((r) => r.path.slice(home.length + 1)).sort();

  check("keeps 5 chats (1 Claude Code + 4 Cowork)", () => assert.equal(out.kept.length, 5, keptRel.join("\n")));
  check("counts 2 duplicate Cowork logs", () => assert.equal(out.dropped.duplicate, 2));
  check("drops audit.jsonl when the session has a real transcript", () => {
    assert.ok(!keptRel.includes(`${sessions}/local_${uuid(1)}/audit.jsonl`));
    assert.ok(!keptRel.includes(`${sessions}/local_${uuid(4)}/audit.jsonl`));
    assert.ok(keptRel.includes(inner(1)));
    assert.ok(keptRel.includes(inner(4)));
  });
  check("keeps audit.jsonl when it's the only chat in the session", () => {
    assert.ok(keptRel.includes(`${sessions}/local_${uuid(2)}/audit.jsonl`));
    assert.ok(keptRel.includes(`${sessions}/local_${uuid(3)}/audit.jsonl`));
  });
  check("every kept chat has its own session id", () => {
    assert.equal(new Set(out.kept.map((r) => r.sessionId)).size, out.kept.length);
  });

  const quick = runJson(["--json", "--quick"]);
  check("--quick drops the same duplicates", () => {
    assert.equal(quick.kept.length, 5);
    assert.equal(quick.dropped.duplicate, 2);
  });

  const text = run([]);
  check("summary says what was left out", () => assert.match(text, /Left out: 2 duplicate Cowork logs/));
  check("hints use `node <file>` by default", () => {
    assert.match(text, new RegExp(`\\n  node ${basename(SCRIPT)} --send\\n`));
    assert.doesNotMatch(text, /bash </);
  });

  const launcher = "bash <(curl -fsSL https://example.test/run.sh)";
  const viaRunner = run([], { VG_BACKFILL_LAUNCHER: launcher });
  check("hints use the launcher when run.sh started it", () => {
    assert.ok(viaRunner.includes(`\n  ${launcher} --send\n`), viaRunner);
    assert.ok(viaRunner.includes(`${launcher} --limit=1 --send`));
    assert.doesNotMatch(viaRunner, /node backfill\.mjs/);
  });
} finally {
  rmSync(home, { recursive: true, force: true });
}

process.stdout.write(failed ? "\nSome checks failed.\n" : "\nAll checks passed.\n");
process.exit(failed ? 1 : 0);
