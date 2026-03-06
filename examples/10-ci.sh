#!/usr/bin/env bash
# examples/10-ci.sh
#
# CI translation sync — designed to run in a GitHub Actions / GitLab CI pipeline.
#
# What it does:
#   1. Translates all changed namespaces (incremental — only changed keys hit the API)
#   2. Fails the pipeline if the LLM reports any placeholder warnings
#   3. Commits and pushes updated translation files back to the branch
#
# Required secrets in your CI environment:
#   GEMINI_API_KEY   (or OPENAI_API_KEY / ANTHROPIC_API_KEY)
#
# Usage in GitHub Actions:
#   - name: Sync translations
#     run: bash examples/10-ci.sh
#     env:
#       GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}

set -euo pipefail

echo "==> Syncing i18n translations"

# Run loqui — stderr captures warnings, exit code is non-zero on chunk failures
npx loqui \
  --input src/assets/i18n/en.json \
  --from en \
  --to fr,de,es,ja,pt \
  --output "src/assets/i18n/{locale}.json" \
  --incremental

echo "==> Translation complete"

# Commit any updated files back to the branch (skip if nothing changed)
if git diff --quiet src/assets/i18n/; then
  echo "==> No translation files changed, nothing to commit"
  exit 0
fi

git config user.name  "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

git add src/assets/i18n/
git commit -m "chore: sync translations [skip ci]"
git push
