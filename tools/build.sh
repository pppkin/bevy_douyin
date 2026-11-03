#!/usr/bin/env bash
# Build a Bevy wasm crate into a Douyin mini-game package.
#
#   ./tools/build.sh --crate ../../platforms/douyin \
#     --out ../../platforms/douyin/package --assets ../../assets \
#     --name my_game --wasm my_game
#
# Options:
#   --crate DIR    Cargo crate directory           (default: .)
#   --out DIR      Douyin package directory        (default: douyin)
#   --assets DIR   Game assets to copy             (default: <crate>/assets)
#   --runtime DIR  Runtime JS directory            (default: ../runtime)
#   --name NAME    wasm-bindgen output / wasm name (default: game)
#   --wasm STEM    Rust wasm stem in target/.../release (default: NAME)
#   --no-minify    Keep the generated JS unminified
#
# The resulting package contains <NAME>.js, <NAME>.wasm.br and runtime/.
# It does not generate game.js/game.json/project.config.json: those are
# game-specific and belong to the consuming game repository.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ORIG_PWD=$(pwd)
RUNTIME_DIR="$SCRIPT_DIR/../runtime"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    echo "see README.md#requirements" >&2
    exit 1
  }
}

need cargo
need wasm-bindgen
need wasm-opt
need brotli
need python3

if command -v rustup >/dev/null 2>&1; then
  if ! rustup target list --installed 2>/dev/null | grep -qx 'wasm32-unknown-unknown'; then
    echo "missing Rust target: wasm32-unknown-unknown" >&2
    echo "run: rustup target add wasm32-unknown-unknown" >&2
    exit 1
  fi
fi

WB_VERSION=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')
if [ "$WB_VERSION" != "0.2.129" ]; then
  echo "warning: wasm-bindgen $WB_VERSION found; this template patches glue for 0.2.129." >&2
  echo "         install the matching CLI with: cargo install wasm-bindgen-cli --version 0.2.129 --force" >&2
fi

CRATE=.
OUT=douyin
ASSETS=
NAME=game
WASM_STEM=
MINIFY=1

while [ $# -gt 0 ]; do
  case "$1" in
    --crate) CRATE=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --assets) ASSETS=$2; shift 2 ;;
    --runtime) RUNTIME_DIR=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    --wasm) WASM_STEM=$2; shift 2 ;;
    --no-minify) MINIFY=0; shift ;;
    -h|--help) sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

RUNTIME_DIR=$(cd "$RUNTIME_DIR" && pwd)
if [ ! -f "$RUNTIME_DIR/adapter.js" ] || [ ! -f "$RUNTIME_DIR/bootstrap.js" ]; then
  echo "runtime not found: $RUNTIME_DIR/adapter.js, $RUNTIME_DIR/bootstrap.js" >&2
  echo "pass --runtime <dir> containing adapter.js and bootstrap.js." >&2
  exit 1
fi

CRATE=$(cd "$CRATE" && pwd)
ASSETS=${ASSETS:-$CRATE/assets}
WASM_STEM=${WASM_STEM:-$NAME}
case "$OUT" in
  /*) ;;
  *) OUT="$ORIG_PWD/$OUT" ;;
esac
mkdir -p "$OUT"

cd "$CRATE"

# Reserve the wasm linear memory up front instead of growing it at runtime.
#
# The iOS Douyin engine (JavaScriptCore inside WKWebView) traps with a bare
# `unreachable executed` - no panic, no log, no console line - whenever
# `memory.grow` is asked for more than a single page at a time:
#   grow: +1 page  => ok
#   grow: +16 pages => [trap] unreachable executed
# The trap is raised from inside the `memory.grow` instruction itself, so the
# Rust allocator never sees `usize::MAX` and cannot fail gracefully; any
# allocation that needs a bigger heap kills the page.
#
# Reserving the memory at link time sidesteps growth entirely: the heap starts
# at `__heap_base` inside an already-large linear memory, and dlmalloc only
# calls `memory.grow` once this reserve is exhausted.
INITIAL_MEMORY_BYTES=${INITIAL_MEMORY_BYTES:-67108864}
export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=--initial-memory=$INITIAL_MEMORY_BYTES"

cargo build --release --target wasm32-unknown-unknown

# Workspace builds put artifacts in the workspace target directory, not next
# to the member crate.  Ask cargo where that is instead of guessing.
TARGET_DIR=$(cargo metadata --format-version 1 --no-deps \
  | python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')
WASM="$TARGET_DIR/wasm32-unknown-unknown/release/$WASM_STEM.wasm"
if [ ! -f "$WASM" ]; then
  echo "wasm not found: $WASM" >&2
  echo "pass --wasm <stem> to select the crate's wasm artifact" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

wasm-bindgen \
  --target no-modules \
  --no-typescript \
  --out-dir "$TMP" \
  --out-name "$NAME" \
  "$WASM"

# Do NOT use --all-features: binaryen 133 enables compact imports, which the
# Douyin wasm engine rejects with `unknown import kind 0x7f`.
wasm-opt -Oz \
  --converge \
  --strip-debug \
  --strip-producers \
  --enable-bulk-memory \
  --enable-mutable-globals \
  --enable-sign-ext \
  --enable-nontrapping-float-to-int \
  --enable-reference-types \
  --enable-multivalue \
  "$TMP/${NAME}_bg.wasm" \
  -o "$TMP/${NAME}_bg.opt.wasm"

# Window 22 is the standard Brotli limit and compresses this binary better
# than the CLI default (24) without requiring decoder extensions.
brotli -q 11 -w 22 -f -o "$OUT/$NAME.wasm.br" "$TMP/${NAME}_bg.opt.wasm"
cp "$TMP/$NAME.js" "$OUT/$NAME.js"
mkdir -p "$OUT/runtime"
cp "$RUNTIME_DIR/adapter.js" "$RUNTIME_DIR/bootstrap.js" "$OUT/runtime/"

# Bevy's AssetServer root is ./assets.  Copy it into the mini-game package so
# `AssetServer::load("sprite.png")` works on the device as it does natively.
# Game assets live outside the platform crate, so the caller can point at the
# shared top-level assets directory.
if [ -d "$ASSETS" ]; then
  rm -rf "$OUT/assets"
  cp -R "$ASSETS" "$OUT/assets"
fi

python3 "$SCRIPT_DIR/patch_glue.py" "$OUT/$NAME.js"

# esbuild is optional, but minifying roughly halves the JavaScript payload.
#
# Target es2017, NOT es2020: esbuild drops unused catch bindings
# (`catch (e)` -> `catch {`), which is ES2019 syntax. The Douyin
# preview/upload compiler parses with Babel's base plugins only and rejects:
#   SyntaxError: gold_front.js: Unexpected token, expected ( (1:22120)
# es2017 makes esbuild re-insert the binding and lowers `?.`/`??`.
minify_js() {
  local file=$1
  if command -v esbuild >/dev/null 2>&1; then
    esbuild "$file" --minify --target=es2017 --log-level=warning --outfile="$file.min"
    mv "$file.min" "$file"
  elif command -v npx >/dev/null 2>&1 && npx --no-install esbuild --version >/dev/null 2>&1; then
    npx --no-install esbuild "$file" --minify --target=es2017 --log-level=warning --outfile="$file.min"
    mv "$file.min" "$file"
  else
    echo "note: esbuild not found; leaving $file unminified" >&2
  fi
}

if [ "$MINIFY" = "1" ]; then
  minify_js "$OUT/$NAME.js"
  minify_js "$OUT/runtime/adapter.js"
fi

# Guard: `catch {` is valid ES2019 and the simulator runs it, so this only
# shows up on 预览/上传. Never ship optional catch bindings again.
if grep -q 'catch{' "$OUT/$NAME.js" "$OUT/runtime/adapter.js"; then
  echo "error: shipped JavaScript contains 'catch{'; the Douyin preview compiler rejects it" >&2
  exit 1
fi

ls -lh "$OUT/$NAME.js" "$OUT/$NAME.wasm.br" "$OUT/runtime/adapter.js" "$OUT/runtime/bootstrap.js"
