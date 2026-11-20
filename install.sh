#!/usr/bin/env bash
# Install cdesign: curl -fsSL https://raw.githubusercontent.com/<owner>/cdesign/main/install.sh | bash
set -euo pipefail

REPO="${CDESIGN_REPO:-dsmarcelo/cdesign}"
REF="${CDESIGN_REF:-main}"
SHARE="${CDESIGN_HOME:-$HOME/.local/share/cdesign}"
BIN="$HOME/.local/bin"

export PATH="$HOME/.bun/bin:$BIN:$PATH"
if ! command -v bun >/dev/null; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

mkdir -p "$(dirname "$SHARE")"
tmp="$(mktemp -d "$SHARE.stage.XXXXXXXX")"
cleanup() {
  if [ -e "$tmp/previous" ] || [ -L "$tmp/previous" ]; then
    if [ ! -e "$SHARE" ] && [ ! -L "$SHARE" ]; then
      mv "$tmp/previous" "$SHARE" || return
    fi
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
BUN_PATH="$(command -v bun)"
if [ -n "${CDESIGN_SRC:-}" ]; then
  checkout="$(cd "$CDESIGN_SRC" && pwd -P)"
  if [ "$checkout" = "$SHARE" ]; then
    echo "The checkout and install directory must be different." >&2
    exit 1
  fi
  (cd "$checkout" && bun install --production --silent)
  ln -s "$checkout" "$tmp/next"
else
  sha="${CDESIGN_INSTALL_SHA:-}"
  if [ -z "$sha" ]; then
    encoded_ref="$(bun -e 'console.log(encodeURIComponent(process.argv[1]))' -- "$REF")"
    sha="$(curl -fsSL --max-time 30 "https://api.github.com/repos/$REPO/commits/$encoded_ref" |
      bun -e 'console.log((await Bun.stdin.json()).sha)')"
  fi
  if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Could not resolve a cdesign commit for $REPO@$REF." >&2
    exit 1
  fi
  echo "Downloading $REPO@$sha..."
  mkdir "$tmp/next"
  curl -fsSL --max-time 120 "https://github.com/$REPO/archive/$sha.tar.gz" | tar -xz --strip-components=1 -C "$tmp/next"
  (cd "$tmp/next" && bun install --production --silent)
  test -f "$tmp/next/src/cli.ts"
  if [ "${CDESIGN_INSTALL_UPDATE:-}" = 1 ]; then
    (cd "$tmp/next" && "$BUN_PATH" src/cli.ts help >/dev/null)
  fi
  bun -e 'const [path, repo, ref, sha] = process.argv.slice(1); await Bun.write(path, JSON.stringify({kind:"archive", repo, ref, sha}))' -- "$tmp/next/.install.json" "$REPO" "$REF" "$sha"
  if [ ! -L "$SHARE" ]; then
    for state in daemon.json projects.json tunnel.json; do
      if [ -f "$SHARE/$state" ]; then cp "$SHARE/$state" "$tmp/next/$state"; fi
    done
  fi
fi

if [ -e "$SHARE" ] || [ -L "$SHARE" ]; then mv "$SHARE" "$tmp/previous"; fi
mv "$tmp/next" "$SHARE"

if [ "${CDESIGN_INSTALL_UPDATE:-}" = 1 ]; then exit 0; fi

mkdir -p "$BIN"
{
  printf '#!/usr/bin/env bash\n'
  if [ -n "${CDESIGN_SRC:-}" ]; then printf 'export CDESIGN_INSTALL_LINK=%q\n' "$SHARE"; fi
  printf 'exec %q %q "$@"\n' "$BUN_PATH" "$SHARE/src/cli.ts"
} > "$BIN/cdesign"
chmod +x "$BIN/cdesign"

if [ "$(uname -s)" = Linux ]; then
  APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$APPS"
  # Desktop Exec quoting is not shell quoting; escape characters interpreted by the desktop parser.
  DESKTOP_BIN="${BIN//\\/\\\\}"
  DESKTOP_BIN="${DESKTOP_BIN//\"/\\\"}"
  DESKTOP_BIN="${DESKTOP_BIN//\$/\\\$}"
  DESKTOP_BIN="${DESKTOP_BIN//\`/\\\`}"
  cat > "$APPS/cdesign.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=cdesign
Comment=Open the cdesign viewer
Exec="$DESKTOP_BIN/cdesign" app
Icon=$SHARE/ui/icon.svg
Terminal=false
Categories=Development;
DESKTOP
  command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" || true
fi

"$BIN/cdesign" install-mcp || true

echo "Installed: $BIN/cdesign"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add $BIN to your PATH." ;; esac
