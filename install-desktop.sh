#!/usr/bin/env bash
# Install cdesign Desktop from this checkout or from a local installer package.
set -euo pipefail
shopt -s nullglob

usage() {
  echo "Usage: ./install-desktop.sh [path-to-package]"
  echo "Supports Arch, Debian/Ubuntu, Fedora, and Windows (from Git Bash)."
}

die() { printf '%s\n' "$*" >&2; exit 1; }

if [[ ${1:-} == -h || ${1:-} == --help ]]; then usage; exit 0; fi
if (( $# > 1 )); then usage >&2; exit 1; fi

package=""
if (( $# )); then
  [[ -f $1 ]] || die "Package file not found: $1"
  package="$(cd -- "$(dirname -- "$1")" && pwd -P)/$(basename -- "$1")"
fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

case "$(uname -s)" in
  Linux)
    [[ $EUID != 0 ]] || die "Run this script as your regular user. It calls sudo when needed."
    [[ -r /etc/os-release ]] || die "Cannot detect the Linux distribution."
    source /etc/os-release
    case " ${ID:-} ${ID_LIKE:-} " in
      *" arch "*) platform=arch; manager=pacman ;;
      *" debian "*|*" ubuntu "*) platform=deb; manager=apt ;;
      *" fedora "*|*" rhel "*) platform=rpm; manager=dnf ;;
      *) die "Unsupported Linux distribution: ${PRETTY_NAME:-unknown}" ;;
    esac
    command -v "$manager" >/dev/null || die "Package manager not found: $manager"
    command -v sudo >/dev/null || die "Install sudo and run this script as a user with sudo access."
    ;;
  MINGW*|MSYS*|CYGWIN*) platform=windows ;;
  *) die "cdesign Desktop installers are available for Linux and Windows." ;;
esac

machine=$(uname -m)
case "$machine" in
  x86_64) deb_arch=amd64; nsis_arch=x64 ;;
  aarch64|arm64) deb_arch=arm64; nsis_arch=arm64; machine=aarch64 ;;
  *) die "Unsupported architecture: $machine" ;;
esac
if [[ $platform == arch && $machine != x86_64 ]]; then
  die "The Arch desktop package currently supports x86-64."
fi

find_package() {
  local candidate
  for candidate in "$@"; do
    if [[ -z $package || $candidate -nt $package ]]; then
      package=$candidate
    fi
  done
}

find_local_package() {
  local target="$PWD/src-tauri/target"
  local profile
  if [[ $platform == arch ]]; then
    find_package "$PWD"/packaging/arch/cdesign-desktop-*-"$machine".pkg.tar.zst
    return
  fi
  for profile in release debug; do
    case "$platform" in
      deb) find_package "$target/$profile"/bundle/deb/cdesign*_"$deb_arch".deb ;;
      rpm) find_package "$target/$profile"/bundle/rpm/cdesign*."$machine".rpm ;;
      windows) find_package "$target/$profile"/bundle/nsis/cdesign*_"$nsis_arch"-setup.exe ;;
    esac
    [[ -z $package ]] || return 0
  done
}

install_package() {
  printf 'Installing %s\n' "$(basename -- "$package")"
  case "$platform:$package" in
    arch:*.pkg.tar.zst) sudo pacman -U -- "$package" ;;
    deb:*.deb) sudo apt install "$package" ;;
    rpm:*.rpm) sudo dnf install "$package" ;;
    windows:*.exe) "$package" ;;
    *) die "This package does not match the detected platform ($platform)." ;;
  esac
}

if [[ -z $package ]]; then find_local_package; fi
if [[ -n $package ]]; then
  install_package
elif [[ $platform == arch ]]; then
  echo "Building cdesign Desktop for Arch Linux."
  sudo pacman -Syu --needed base-devel
  (cd packaging/arch && makepkg -si)
elif [[ $platform == windows ]]; then
  die "Pass the Windows setup .exe from the Desktop installers workflow, or build it with bun run desktop:build."
else
  echo "Installing build dependencies for cdesign Desktop."
  case "$platform" in
    deb)
      sudo apt update
      sudo apt install build-essential curl unzip pkg-config libwebkit2gtk-4.1-dev libxdo-dev
      ;;
    rpm)
      sudo dnf install gcc make curl unzip pkgconf-pkg-config webkit2gtk4.1-devel libxdo-devel
      ;;
  esac
  export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
  if ! command -v bun >/dev/null; then curl -fsSL https://bun.sh/install | bash; fi
  rust_version=$(rustc --version 2>/dev/null || true)
  # The pinned Tauri crates require Rust 1.90 or newer.
  if ! [[ $rust_version =~ ^rustc\ 1\.([0-9]+) ]] || (( BASH_REMATCH[1] < 90 )) || ! cargo --version >/dev/null 2>&1; then
    if command -v rustup >/dev/null; then
      rustup toolchain install stable --profile minimal
    else
      curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
    fi
    export RUSTUP_TOOLCHAIN=stable
  fi
  # Use the same output directory for building and locating the resulting package.
  export CARGO_TARGET_DIR="$PWD/src-tauri/target"
  bun install --frozen-lockfile
  bun run desktop:build --ci --bundles "$platform"
  find_local_package
  [[ -n $package ]] || die "Build finished but no $platform package was found."
  install_package
fi

echo "Open cdesign Desktop from your applications menu."
