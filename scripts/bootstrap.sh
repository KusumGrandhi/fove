#!/usr/bin/env bash
#
# Set up fove on a fresh Mac: check what is missing, install what brew can,
# build the app, and put it in /Applications.
#
# Safe to re-run. Every step is skipped when it has already been done, so this
# doubles as a repair for an install that has drifted.
#
#   ./scripts/bootstrap.sh            # check, install, build, install app
#   ./scripts/bootstrap.sh --check    # report only, change nothing
#
set -euo pipefail

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

cd "$(dirname "$0")/.."

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

# ---- 1. the machine -------------------------------------------------------

bold "Machine"

if [[ "$(uname -s)" != "Darwin" ]]; then
  bad "fove is macOS-only (this is $(uname -s))."
  exit 1
fi
ok "macOS $(sw_vers -productVersion)"

# node-pty is compiled, so the architecture is not a preference.
ARCH="$(uname -m)"
if [[ "$ARCH" != "arm64" ]]; then
  warn "This is $ARCH. The build targets arm64; expect to change the"
  warn "electron-builder target in package.json before packaging."
else
  ok "arm64"
fi

# ---- 2. the tools ---------------------------------------------------------
#
# Kept in step with src/shared/deps.ts. The severities are the same three:
# required means the app is pointless without it, feature means one pane
# stops working, optional means there is another way to do the same thing.

bold "Tools"

# Seeded empty, and always expanded with a default: macOS ships bash 3.2,
# where `${arr[@]}` on an empty array trips `set -u`.
MISSING_REQUIRED=()
MISSING_BREW=()

# bin:severity:brew-formula-or-empty:what-it-is-for
TOOLS=(
  "claude:required::Claude Code itself — every claude pane"
  "git:required:git:the git pane, worktrees, diffs"
  "tmux:feature:tmux:teammate tabs"
  "rg:feature:ripgrep:the search pane"
  "code:optional::the open-in-VS-Code buttons"
)

for entry in "${TOOLS[@]}"; do
  IFS=":" read -r bin severity formula purpose <<< "$entry"
  if command -v "$bin" >/dev/null 2>&1; then
    ok "$bin — $(command -v "$bin")"
  else
    case "$severity" in
      required) bad "$bin is missing — $purpose" ; MISSING_REQUIRED+=("$bin") ;;
      feature)  warn "$bin is missing — $purpose" ;;
      optional) warn "$bin is missing — $purpose (optional)" ;;
    esac
    [[ -n "$formula" ]] && MISSING_BREW+=("$formula")
  fi
done

if [[ ${#MISSING_BREW[@]:-0} -gt 0 ]]; then
  if command -v brew >/dev/null 2>&1; then
    if [[ $CHECK_ONLY -eq 1 ]]; then
      warn "brew install ${MISSING_BREW[*]:-}"
    else
      bold "Installing: ${MISSING_BREW[*]}"
      brew install "${MISSING_BREW[@]:-}"
    fi
  else
    warn "Homebrew is not installed; see https://brew.sh"
    warn "Then: brew install ${MISSING_BREW[*]:-}"
  fi
fi

# Claude Code is not a brew formula in the general case, so it is named
# rather than installed.
for bin in "${MISSING_REQUIRED[@]:-}"; do
  [[ "$bin" == "claude" ]] && warn "Install Claude Code: https://claude.com/claude-code"
done

if [[ $CHECK_ONLY -eq 1 ]]; then
  bold "Check only; nothing was changed."
  exit 0
fi

if [[ ${#MISSING_REQUIRED[@]:-0} -gt 0 ]]; then
  bad "Still missing: ${MISSING_REQUIRED[*]:-}. Install them, then re-run."
  exit 1
fi

# ---- 3. the app -----------------------------------------------------------

bold "Building"

if ! command -v node >/dev/null 2>&1; then
  bad "node is missing. Install Node 20+ (brew install node, or nvm)."
  exit 1
fi
ok "node $(node --version)"

# `npm ci` when the lockfile matches, which is the reproducible path; `npm i`
# when there is no lockfile to honour.
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
ok "dependencies installed"

npm run typecheck
ok "typecheck"

npm run install:local

bold "Done"
echo "  fove is in /Applications. Open it from Spotlight."
echo
echo "  It is signed ad-hoc, so the first launch needs right-click → Open"
echo "  (or: xattr -dr com.apple.quarantine /Applications/fove.app)."
