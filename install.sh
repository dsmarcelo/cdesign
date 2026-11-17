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

if [ -n "${CDESIGN_SRC:-}" ]; then
  # dev install: link the checkout so edits apply immediately
  rm -rf "$SHARE"; mkdir -p "$(dirname "$SHARE")"
  ln -s "$(cd "$CDESIGN_SRC" && pwd)" "$SHARE"
else
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  echo "Downloading $REPO@$REF..."
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/$REF.tar.gz" | tar -xz -C "$tmp"
  rm -rf "$SHARE"; mkdir -p "$(dirname "$SHARE")"
  mv "$tmp"/*/ "$SHARE"
fi

(cd "$SHARE" && bun install --production --silent)

mkdir -p "$BIN"
BUN_PATH="$(command -v bun)"
cat > "$BIN/cdesign" <<LAUNCHER
#!/usr/bin/env bash
exec "$BUN_PATH" "$SHARE/src/cli.ts" "\$@"
LAUNCHER
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
