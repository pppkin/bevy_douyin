# bevy-douyin-adapter

Reusable Douyin mini-game scaffolding for Bevy 0.20 / wasm-bindgen projects.

This repository is the **adapter**, not a runnable game. It owns the
browser-shaped runtime shim, the wasm-bindgen glue patch, the package build
script, and a copyable package template. The consuming game repository owns
its own `Cargo.toml`, Rust entry point, `Host` implementation, assets, and
game-specific `game.js` / `game.json` / `project.config.json`.

The original clone-and-run starter is preserved on the `starter` branch and
tag `starter-v1`. `main` is now the adapter.

## Layout

```text
runtime/
  adapter.js        DOM / canvas / WebGL2 / RAF / input shim
  bootstrap.js      installs the shim, then loads the wasm-bindgen glue
tools/
  build.sh          cargo + wasm-bindgen + wasm-opt + brotli + glue patch
  patch_glue.py     patches wasm-bindgen 0.2.129 for the Douyin runtime
template/
  package/          game.js / game.json / project.config.json starter files
  README.md         package copy and host integration notes
```

## Quick start

### 1. Add the adapter as a submodule

```bash
git submodule add -b main https://gitee.com/pppkin/bevy_douyin.git addons/bevy-douyin
git submodule update --init addons/bevy-douyin
```

Pinning a release tag is recommended for reproducible builds:

```bash
git -C addons/bevy-douyin checkout adapter-v0.2.1
git add addons/bevy-douyin
git commit -m "chore: pin bevy-douyin adapter v0.2.1"
```

If the Gitee repository is private, use your SSH remote or request access first.

### 2. Copy the package template

```bash
mkdir -p platforms/douyin/package
cp -R addons/bevy-douyin/template/package/. platforms/douyin/package/
```

Replace the placeholders in `game.js` and `project.config.json`; add your own
`icon.png`. See [`template/README.md`](template/README.md) for the full list.

### 3. Add the Rust side

Keep a thin platform crate in the game repository, for example:

```text
platforms/douyin/
  Cargo.toml
  src/main.rs       game entry: run(GameConfig, Arc::new(DouyinHost::default()))
  src/host.rs       DouyinHost: storage / rewarded ads / safe area / logging
  package/          game.js, game.json, project.config.json, icon.png
```

The game's `Host` implementation owns the `tt.*` SDK calls; the adapter only
bridges them through the globals listed below.

### 4. Build

```bash
./addons/bevy-douyin/tools/build.sh \
  --crate platforms/douyin \
  --out platforms/douyin/package \
  --assets assets \
  --name my_game \
  --wasm my_game
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--crate DIR` | `.` | Cargo crate directory |
| `--out DIR` | `douyin` | Output Douyin package directory |
| `--assets DIR` | `<crate>/assets` | Game assets copied into the package |
| `--runtime DIR` | adapter `runtime/` | Runtime JS directory |
| `--name NAME` | `game` | Glue JS and wasm output stem (`<NAME>.js`, `<NAME>.wasm.br`) |
| `--wasm STEM` | `NAME` | Rust wasm artifact stem in `target/.../release/` |
| `--no-minify` | off | Keep generated JS unminified |

`template/package/game.js` must use the same `--name` for both `wasm` and
`glue`; `--wasm` only selects the Rust-side artifact. The build does **not**
generate or overwrite `game.js` / `game.json` / `project.config.json`.

### 5. Import into Douyin DevTools

Import `platforms/douyin/package/` (not the repository root), compile, and
refresh the simulator. The package contains:

```text
<name>.js
<name>.wasm.br
runtime/adapter.js
runtime/bootstrap.js
assets/
```

## Runtime → Rust globals

`adapter.install()` publishes host facts on both `GameGlobal` and `window`
under `globalPrefix` (default `__bevy_douyin_`):

| Name | Direction | Meaning |
| --- | --- | --- |
| `<prefix>Canvas` | JS → Rust | logical canvas size `{ width, height }` |
| `<prefix>SafeArea` | JS → Rust | insets, screen size, menu button |
| `<prefix>Theme` | both | `"dark"` / `"light"` |
| `<prefix>SetTheme` | Rust → JS | manual appearance override |
| `<prefix>AdStatus` | JS → Rust | rewarded-video state |
| `<prefix>ShowAd` | Rust → JS | start a rewarded video |

If a game overrides `globalPrefix`, its Rust host constants must match.

## Requirements

- Rust target `wasm32-unknown-unknown`
- `wasm-bindgen` 0.2.129
- `wasm-opt` (binaryen)
- `brotli`
- `python3`
- optional: `esbuild` for JavaScript minification

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129
brew install binaryen brotli          # macOS
npm install -g esbuild                # optional
```

## Versioning

The submodule tracks `main`, but releases are tagged. Updating is deliberate:

```bash
git submodule update --remote addons/bevy-douyin
git add addons/bevy-douyin
git commit -m "chore: bump bevy-douyin adapter"
```

## License

WTFPL, see `LICENSE`. The runtime and glue patch originate from
`pppkin/bevy_douyin`; this repository keeps the reusable adapter pieces and
preserves the original starter on the `starter` branch.
