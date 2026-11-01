#!/usr/bin/env bash
# Deploy the hosted site (Cloudflare Pages, fabx.leolabs.me) from a clean export of HEAD.
# Pages would otherwise publish the whole repo root; repo-only paths listed in .assetsignore stay out of site/.
# The export root keeps functions/, wrangler.toml and the modules functions import, so bindings and /api/* deploy as before.
#   bash scripts/deploy-pages.sh            # production (branch main)
#   bash scripts/deploy-pages.sh preview    # preview branch
set -euo pipefail
branch="${1:-main}"
root="$(git rev-parse --show-toplevel)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
git -C "$root" archive HEAD | tar -x -C "$out"
mkdir "$out/site"
shopt -s dotglob nullglob
# Copy, not move: functions import modules from the repo root (alerts/, api-url.mjs) and wrangler bundles them from there.
for path in "$out"/*; do case "${path##*/}" in site|functions) ;; *) cp -R "$path" "$out/site/";; esac; done
while IFS= read -r pattern; do
  [[ -z "$pattern" || "$pattern" == \#* ]] && continue
  case "$pattern" in /*|*..*) echo "deploy-pages: unsafe .assetsignore entry: $pattern" >&2; exit 1;; esac
  (cd "$out/site" && rm -rf -- $pattern)
  find "$out/site" -mindepth 2 -name "$pattern" -prune -exec rm -rf {} +
done < "$root/.assetsignore"
# Fail closed if anything config- or secret-shaped is still headed for the public site.
leftover="$(cd "$out/site" && find . \( -name 'wrangler.toml' -o -name '*.sql' -o -name '.dev.vars*' -o -name '*.pem' -o -name '.env*' -o -name '*.md' \) -print)"
if [[ -n "$leftover" ]]; then echo "deploy-pages: refusing to upload:" >&2; echo "$leftover" >&2; exit 1; fi
cd "$out"
wrangler pages deploy site --project-name fabx-miner-desk --branch "$branch" \
  --commit-hash "$(git -C "$root" rev-parse --short HEAD)" --commit-message "$(git -C "$root" log -1 --format=%s)" --commit-dirty=false
