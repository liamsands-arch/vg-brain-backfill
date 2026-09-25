#!/usr/bin/env bash
# VG Brain backfill — one-command runner. Works whether or not you have Node.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/liamsands-arch/vg-brain-backfill/main/run.sh) --send
#
# Leave off --send to just look. Everything after the one-liner is passed
# straight to backfill.mjs (try --help).
#
# What it does: makes a temporary folder, downloads backfill.mjs into it, uses
# your own Node if you have version 18 or newer (otherwise downloads a private
# copy of the official Node into that same folder), runs the backfill, and
# deletes the folder when it finishes — however it finishes. Nothing is
# installed and nothing is left behind.
#
# Use it with bash <(curl …), not curl … | bash: the <( ) form keeps your
# keyboard connected, so the "type yes" question before sending still works.

set -euo pipefail

RAW="https://raw.githubusercontent.com/liamsands-arch/vg-brain-backfill/main"
NODE_VERSION="v22.20.0"
# Overridable so the runner can be tested against a local copy (file:///…).
SCRIPT_URL="${VG_BACKFILL_URL:-$RAW/backfill.mjs}"

WORK=""
cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT
# Ctrl-C, a closed Terminal window, or a kill still go through cleanup.
trap 'exit 130' INT
trap 'exit 129' HUP
trap 'exit 143' TERM

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vg-brain-backfill.XXXXXX")"

if ! curl -fsSL "$SCRIPT_URL" -o "$WORK/backfill.mjs"; then
  echo "Couldn't download the backfill script. Check your internet connection and try again." >&2
  exit 1
fi

# A `node` on PATH that is version 18 or newer, or nothing.
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -ge 18 ]
}

if node_ok; then
  NODE="node"
else
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) echo "Sorry, this runner only knows how to get Node for macOS and Linux." >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) echo "Sorry, this runner doesn't know how to get Node for a $(uname -m) machine." >&2; exit 1 ;;
  esac
  name="node-$NODE_VERSION-$os-$arch"
  echo "Getting a private copy of Node for this run; it's deleted when it finishes."
  if ! curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$name.tar.gz" -o "$WORK/node.tar.gz" \
     || ! tar xzf "$WORK/node.tar.gz" -C "$WORK"; then
    echo "Couldn't download Node. Check your internet connection and try again." >&2
    exit 1
  fi
  rm -f "$WORK/node.tar.gz"
  NODE="$WORK/$name/bin/node"
fi

# An older set of instructions had people save backfill.mjs in their home
# folder and leave it there. Tidy that up, but only if it's recognisably ours.
if [ -f "$HOME/backfill.mjs" ] \
   && head -n 1 "$HOME/backfill.mjs" | grep -q '^#!/usr/bin/env node' \
   && head -n 5 "$HOME/backfill.mjs" | grep -q 'find old Claude transcripts on this Mac'; then
  rm -f "$HOME/backfill.mjs"
  echo "Removed an old copy of backfill.mjs from your home folder (this runner doesn't need it)."
fi

# So every "run this next" hint the script prints is this same one-liner, not a
# `node …` command that may not work on this Mac.
export VG_BACKFILL_LAUNCHER="bash <(curl -fsSL $RAW/run.sh)"

status=0
"$NODE" "$WORK/backfill.mjs" "$@" || status=$?
exit "$status"
