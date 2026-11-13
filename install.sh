#!/usr/bin/env bash
# Kelbo installer for macOS, Linux and WSL.
#
#   curl -fsSL https://raw.githubusercontent.com/kelbodev/kelbo/main/install.sh | bash
#   bash install.sh --dir ~/kelbo --port 3500
#
# Checks Node.js and git, clones Kelbo at the latest release tag (v<x.y.z>), installs its
# dependencies and starts it under PM2 (offering to install PM2 when it is missing). Run again
# on an existing installation, it updates it. It never touches config.json.
#
# Options (or environment variables):
#   --dir DIR         KELBO_DIR    installation folder (default ~/kelbo)
#   --port PORT       KELBO_PORT   port Kelbo listens on (default 3500)
#   --version vX.Y.Z  KELBO_VERSION a given release instead of the latest
#   --repo URL        KELBO_REPO   repository (default https://github.com/kelbodev/kelbo.git)
#   --yes                          install PM2 without asking when it is missing
#   --no-pm2                       don't use PM2: install only, start Kelbo yourself
set -euo pipefail

MIN_NODE=18
DIR="${KELBO_DIR:-$HOME/kelbo}"
PORT="${KELBO_PORT:-}"
REPO="${KELBO_REPO:-https://github.com/kelbodev/kelbo.git}"
VERSION="${KELBO_VERSION:-}"
YES=0
USE_PM2=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    --no-pm2) USE_PM2=0; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# yes/no question also when the script comes from "curl | bash" (answers read from the terminal)
ask() {
  local answer=""
  if [ "$YES" = 1 ]; then return 0; fi
  if [ -t 0 ]; then read -r -p "    $1 [Y/n] " answer
  elif [ -r /dev/tty ]; then read -r -p "    $1 [Y/n] " answer < /dev/tty
  else return 1; fi
  case "$answer" in ''|y|Y|yes|s|S|si) return 0 ;; *) return 1 ;; esac
}

if [ -n "$PORT" ] && ! [[ "$PORT" =~ ^[0-9]+$ ]]; then die "Invalid port: $PORT"; fi
case "$VERSION" in ''|v[0-9]*.[0-9]*.[0-9]*) ;; *) die "Invalid version: $VERSION (expected vX.Y.Z)" ;; esac
DIR="${DIR/#\~/$HOME}"

step "Checking the requirements"
command -v git >/dev/null 2>&1 || die "git is not installed: install it and run this script again."
command -v node >/dev/null 2>&1 || die "Node.js is not installed: install Node.js $MIN_NODE or later (https://nodejs.org) and run this script again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge "$MIN_NODE" ] || die "Node.js $(node -v) is too old: Kelbo needs Node.js $MIN_NODE or later."
command -v npm >/dev/null 2>&1 || die "npm is not installed (it comes with Node.js)."
ok "git $(git --version | awk '{print $3}'), Node.js $(node -v), npm $(npm -v)"

if [ -z "$VERSION" ]; then
  step "Looking for the latest Kelbo release"
  VERSION="$(git ls-remote --tags --refs "$REPO" 'v*' 2>/dev/null | awk -F/ '{print $3}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
  [ -n "$VERSION" ] || die "No release found in $REPO (is the address right, is the network up?)"
fi
ok "Kelbo $VERSION"

if [ -d "$DIR/.git" ]; then
  step "Updating the installation in $DIR"
  NAME="$(node -p 'try { require(require("path").resolve(process.argv[1], "package.json")).name } catch { "" }' "$DIR")"
  [ "$NAME" = "kelbo" ] || die "$DIR is a git repository but not Kelbo: choose another folder with --dir."
  # package-lock.json rewritten by an npm install doesn't count: it is put back
  git -C "$DIR" checkout --quiet -- package-lock.json 2>/dev/null || true
  CHANGES="$(git -C "$DIR" status --porcelain --untracked-files=no)"
  [ -z "$CHANGES" ] || die "$DIR has local changes (git status): save or undo them, then run this script again."
  git -C "$DIR" fetch --quiet --no-tags origin "refs/tags/$VERSION:refs/tags/$VERSION" || die "Download of $VERSION failed."
  TARGET="$(git -C "$DIR" rev-parse "$VERSION^{commit}")"
  if [ "$(git -C "$DIR" rev-parse HEAD)" = "$TARGET" ]; then
    ok "Already at $VERSION"
  else
    git -C "$DIR" merge-base --is-ancestor HEAD "$TARGET" || die "$VERSION doesn't follow the installed version (different history): update refused."
    if BRANCH="$(git -C "$DIR" symbolic-ref --quiet --short HEAD)"; then
      git -C "$DIR" merge --quiet --ff-only "$TARGET"
      ok "Branch $BRANCH moved to $VERSION"
    else
      git -C "$DIR" -c advice.detachedHead=false checkout --quiet --detach "$TARGET"
      ok "Moved to $VERSION"
    fi
  fi
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR exists and is not empty: choose another folder with --dir."
else
  step "Downloading Kelbo $VERSION into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git -c advice.detachedHead=false clone --quiet --branch "$VERSION" "$REPO" "$DIR" || die "Download failed."
  ok "Downloaded"
fi

step "Installing the dependencies"
# npm ci keeps package-lock.json as released; npm install only if that fails (lock put back)
NPM_FLAGS="--ignore-scripts --no-audit --no-fund --omit=dev --loglevel=error"
if ! (cd "$DIR" && npm ci $NPM_FLAGS); then
  (cd "$DIR" && npm install $NPM_FLAGS) || die "npm install failed."
  git -C "$DIR" checkout --quiet -- package-lock.json 2>/dev/null || true
fi
ok "Dependencies installed"

URL="http://127.0.0.1:${PORT:-3500}"
if [ "$USE_PM2" = 1 ] && ! command -v pm2 >/dev/null 2>&1; then
  step "PM2"
  warn "PM2 keeps Kelbo running in the background and restarts it after an update from the interface."
  if ask "Install PM2 now (npm install -g pm2)?"; then
    npm install -g pm2 --no-audit --no-fund --loglevel=error || die "Installing PM2 failed: run 'npm install -g pm2' (maybe with sudo) and this script again."
    ok "PM2 $(pm2 -v) installed"
  else
    USE_PM2=0
  fi
fi

if [ "$USE_PM2" = 1 ]; then
  step "Starting Kelbo with PM2"
  if pm2 describe kelbo >/dev/null 2>&1; then
    if [ -n "$PORT" ]; then KELBO_PORT="$PORT" pm2 restart kelbo --update-env >/dev/null; else pm2 restart kelbo >/dev/null; fi
    ok "Restarted (PM2 process 'kelbo')"
  else
    if [ -n "$PORT" ]; then KELBO_PORT="$PORT" pm2 start "$DIR/server.js" --name kelbo --cwd "$DIR" >/dev/null
    else pm2 start "$DIR/server.js" --name kelbo --cwd "$DIR" >/dev/null; fi
    ok "Started (PM2 process 'kelbo')"
  fi
  pm2 save >/dev/null && ok "Saved in the PM2 process list"
  printf '\n\033[1;32mKelbo %s is running: %s\033[0m\n' "$VERSION" "$URL"
  echo "To start it at login too: pm2 startup (then follow its instructions)."
else
  printf '\n\033[1;32mKelbo %s is installed in %s\033[0m\n' "$VERSION" "$DIR"
  echo "Start it with:  cd \"$DIR\" && ${PORT:+KELBO_PORT=$PORT }npm start   → $URL"
fi
