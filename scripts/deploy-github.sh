#!/usr/bin/env bash
set -euo pipefail

# Squashes the current `main` into a single commit and force-pushes it to
# `github`/main, so the public repo always shows exactly one commit
# reflecting the current tree. Rewrites GitHub's history every run, so it
# requires --squash to confirm — never triggered by habit. The private
# `origin` remote is never touched. This script (scripts/) is tracked on
# `main` for backup, but is excluded from the squash — maintainer-only
# tooling, not part of the public repo.

if [ "${1:-}" != "--squash" ]; then
  echo "This force-pushes a single squashed commit over GitHub's history." >&2
  echo "Re-run with: npm run github:deploy -- --squash" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

if ! git remote get-url github >/dev/null 2>&1; then
  echo "No 'github' remote configured. Run: git remote add github <url>" >&2
  exit 1
fi

branch="$(git branch --show-current)"
if [ "$branch" != "main" ]; then
  echo "Must be on 'main' to deploy (currently on '$branch')." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree not clean — commit or stash changes first." >&2
  exit 1
fi

cleanup() {
  git checkout main >/dev/null 2>&1 || true
  git branch -D github-release >/dev/null 2>&1 || true
}
trap cleanup EXIT

git branch -D github-release >/dev/null 2>&1 || true
git checkout --orphan github-release
git add -A -- . ':!scripts'
git commit -q -m "Public release snapshot"
git push github github-release:main --force

echo "Pushed squashed snapshot to github/main."
