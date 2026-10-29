#!/usr/bin/env sh
# Managed by ways. Appends the active ways work to the user's own statusline.
# Usage: <script> [original statusline command]
input="$(cat)"
prefix=""
if [ -n "$1" ]; then prefix="$(printf '%s' "$input" | sh -c "$1" 2>/dev/null)"; fi
dir="$(printf '%s' "$input" | sed -n 's/.*"project_dir": *"\([^"]*\)".*/\1/p')"
[ -n "$dir" ] || dir="$(printf '%s' "$input" | sed -n 's/.*"cwd": *"\([^"]*\)".*/\1/p')"
[ -n "$dir" ] || dir="$PWD"
out="ways: idle"
for gitdir in $(git -C "$dir" rev-parse --path-format=absolute --git-dir --git-common-dir 2>/dev/null); do
  file="$gitdir/ways/active.json"
  if [ -f "$file" ]; then
    id="$(sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' "$file" | head -n 1)"
    kind="$(sed -n 's/.*"kind": *"\([^"]*\)".*/\1/p' "$file" | head -n 1)"
    [ -n "$id" ] && out="ways: $kind $id" && break
  fi
done
if [ -n "$prefix" ]; then printf '%s | %s' "$prefix" "$out"; else printf '%s' "$out"; fi
