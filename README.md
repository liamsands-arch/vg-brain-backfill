# vg-brain-backfill

One script. It finds old Claude transcripts on your Mac and sends them to your
own VG Brain notes.

Back when Claude Code and Cowork kept chats on your own machine, every session
left a `.jsonl` transcript behind. Claude keeps chats in the cloud now, so
nothing new lands on disk — but the old files are still sitting there, and the
brain has never seen them.

## Use it

Open Terminal and paste these in, one at a time:

```sh
curl -fsSL https://raw.githubusercontent.com/liamsands-arch/vg-brain-backfill/main/backfill.mjs -o backfill.mjs

node backfill.mjs --login  # SIGN IN — opens your browser, once

node backfill.mjs          # LOOK — what's on this machine?

node backfill.mjs --send   # SEND — upload it
```

You need Node 18 or newer. If you've run Claude Code, you have it. Check with
`node --version`.

## What the first command does

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
doesn't open a network connection at all.

## Narrowing it down before you send

```sh
node backfill.mjs --list                  # every file, not just the totals
node backfill.mjs --since=2025-06-01      # only chats from June onward
node backfill.mjs --project=acme          # only folders matching "acme"
node backfill.mjs --exclude=scratch       # skip folders matching "scratch"
node backfill.mjs --help                  # everything else
```

Combine them with `--send` when you're happy:

```sh
node backfill.mjs --since=2025-06-01 --exclude=scratch --send
```

## What the second command does

Asks you to type `yes`, then uploads.

Everything lands in **your own notes** — private, the same as anything you save
yourself. Nobody else at VG can read it unless you later share a specific note.

The raw chat isn't published anywhere. The server reads it and files the
durable pieces: a decision and the reason behind it, a method you'll run again,
a number that got reconciled. That runs on its own schedule, so check your
notes later the same day rather than straight away.

Re-running it is safe. It asks the server what it already has and skips it, so
you won't get duplicates and you won't re-upload gigabytes.

## Signing in

`node backfill.mjs --login` opens your browser. Sign in with the same account
you use for VG Brain and you're done — it's saved on this Mac, and it tells you
whose brain you just connected to so you can be sure it's yours.

Nobody sends you a password or a token. Nothing gets pasted into Slack. It's
the same sign-in the VG Brain connector does, and if you already have the
connector installed the script finds that login on its own and you can skip
this step entirely.

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
