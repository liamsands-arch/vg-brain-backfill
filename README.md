# vg-brain-backfill

One script. It finds old Claude transcripts on your Mac and sends them to your
own VG Brain notes.

Back when Claude Code and Cowork kept chats on your own machine, every session
left a `.jsonl` transcript behind. Claude keeps chats in the cloud now, so
nothing new lands on disk — but the old files are still sitting there, and the
brain has never seen them.

## Use it

Open Terminal and paste this in. It signs you in, shows you what it found, and
asks before it sends anything — the only thing you type is `yes`.

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/liamsands-arch/vg-brain-backfill/main/run.sh) --send
```

That works whether or not you have Node on your Mac (most Cowork users don't).
If you don't, it borrows a private copy just for this run. Everything it
downloads goes in a temporary folder that's deleted when it finishes, even if
you stop it halfway, so there's nothing to clean up afterwards.

If you'd rather look before committing to anything, leave off `--send` — that
only reads, and uploads nothing:

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/liamsands-arch/vg-brain-backfill/main/run.sh)
```

Paste it exactly as written. The `bash <(…)` part matters: it keeps the `yes`
question working.

### If you already have Node

If `node --version` prints v18 or higher, you can also save the script and run
it directly. The rest of this page uses this shorter form; with the one-liner
above, just put the same options after it instead of after `node backfill.mjs`.

```sh
curl -fsSL https://raw.githubusercontent.com/liamsands-arch/vg-brain-backfill/main/backfill.mjs -o backfill.mjs
node backfill.mjs --send
```

## What looking does

Nothing goes anywhere. It walks the places Claude used to keep transcripts —
`~/.claude/projects`, `~/Library/Application Support/Claude` and a couple of
others — works out which `.jsonl` files are actually chats (a lot of them
aren't), and prints a table:

```
----------------------------------------------------------------------------
WHAT'S ON THIS MACHINE                   chats  messages     size   first … last
----------------------------------------------------------------------------
acme  (-Users-sam-code-acme)                34      2,918   14 MB   2025-02-11 … 2026-01-04
Cowork  (local sessions)                     9        610    3 MB   2025-06-02 … 2025-09-30
----------------------------------------------------------------------------
2 projects                                  43      3,528   17 MB   2025-02-11 … 2026-01-04

Nothing has been sent. This was a look, not an upload.
```

It reads your files and prints counts. It doesn't print what's in them, and it
doesn't send anything anywhere. (The one-liner does download the script itself,
and Node if you need it, before it starts looking.)

Cowork kept two copies of most chats: the chat itself and an `audit.jsonl` log
of the same session. The script counts each chat once and leaves the extra log
out (the summary says "duplicate Cowork logs"), so you don't end up with two
notes about the same conversation. If the log is the only copy of a chat, it's
kept.

## Trying one first

You don't have to commit to everything at once:

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/liamsands-arch/vg-brain-backfill/main/run.sh) --limit=1 --send
```

That sends your single most recent chat and nothing else. Look at your notes
later in the day, decide you like what came back, then widen. Re-running is
always safe — it asks the server what it already has and skips it.

## Narrowing it down before you send

These are written in the short `node backfill.mjs` form. If you're using the
one-liner, put the same option after it instead, like
`bash <(curl -fsSL https://raw.githubusercontent.com/liamsands-arch/vg-brain-backfill/main/run.sh) --list`.

```sh
node backfill.mjs --list                  # every file, not just the totals
node backfill.mjs --since=2025-06-01      # only chats from June onward
node backfill.mjs --project=acme          # only folders matching "acme"
node backfill.mjs --exclude=scratch       # skip folders matching "scratch"
node backfill.mjs --limit=10              # just the 10 most recent
node backfill.mjs --help                  # everything else
```

Combine them with `--send` when you're happy:

```sh
node backfill.mjs --since=2025-06-01 --exclude=scratch --send
```

## What sending does

Asks you to type `yes`, then uploads.

Everything lands in **your own notes** — private, the same as anything you save
yourself. Nobody else at VG can read it unless you later share a specific note.

The raw chat isn't published anywhere. The server reads it and files the
durable pieces: a decision and the reason behind it, a method you'll run again,
a number that got reconciled. That runs on its own schedule, so check your
notes later the same day rather than straight away.

Re-running it is safe. It asks the server what it already has and skips it, so
you won't get duplicates and you won't re-upload gigabytes.

One thing that can look like a failure but isn't: if a chat was already saved
to the brain back when it happened, sending it again files nothing. The brain
recognises it and declines to write the same conversation twice. Chats it has
never seen — which is the whole point of this — get read properly.

## Signing in

`node backfill.mjs --login` opens your browser. Sign in with the same account
you use for VG Brain and you're done — it's saved on this Mac, and it tells you
whose brain you just connected to so you can be sure it's yours.

Nobody sends you a password or a token. Nothing gets pasted into Slack. It's
the same sign-in the VG Brain connector does, and if you already have the
connector installed the script finds that login on its own and you can skip
this step entirely.

(`--send` signs you in on its own the first time, so you rarely need this.
All of these work after the one-liner too.)

Two others worth knowing:

```sh
node backfill.mjs --whoami   # is my sign-in working, and whose brain is it?
node backfill.mjs --logout   # forget the sign-in on this Mac
```

Logins last about a month. When one runs out, `--login` again.

## If it says "NOT stored — capture-disabled"

That's a switch on the server, not anything you did. Tell Liam. Nothing was
lost — re-run it once he's flipped it, and the chats that did go through won't
be sent twice.

---

Source of truth for this script is `scripts/vg-brain-backfill.mjs` in the
private vg-brain repo, where it's covered by `npm run test:backfill-script`.
This repo is the public copy so it can be curled without a GitHub account.
