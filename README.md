# bevy-douyin-adapter

Reusable Douyin mini-game scaffolding for Bevy 0.20 / wasm-bindgen projects.

This repository is intentionally game-agnostic. It owns the browser-shaped
runtime shim, the wasm-bindgen glue patch, and the package build script. The
consuming game repository owns its own `game.js`, `game.json`,
`project.config.json`, icon, assets, and Rust platform entry.

## Layout

```text
runtime/
  adapter.js        DOM / canvas / WebGL2 / RAF / input shim
  bootstrap.js      installs the shim, then loads the wasm-bindgen glue
tools/
  build.sh          cargo + wasm-bindgen + wasm-opt + brotli + glue patch
  patch_glue.py     patches wasm-bindgen 0.2.129 for the Douyin runtime
```

## Use as a submodule

```bash
git submodule add <this-repo-url> addons/bevy-douyin
git submodule update --init addons/bevy-douyin
```

The game keeps a thin platform crate, for example:

```text
platforms/douyin/
  Cargo.toml
  src/main.rs       gold_front::run(GameConfig, Arc::new(DouyinHost::default()))
  src/host.rs       DouyinHost: storage / rewarded ads / safe area / logging
  package/          game.js, game.json, project.config.json, icon.png
```

Then build:

```bash
./addons/bevy-douyin/tools/build.sh \
  --crate platforms/douyin \
  --out platforms/douyin/package \
  --assets assets \
  --name gold_front \
  --wasm gold_front
```

The output package contains:

```text
<name>.js
<name>.wasm.br
runtime/adapter.js
runtime/bootstrap.js
assets/
```

The build script does **not** generate `game.js` / `game.json` /
`project.config.json`; those are game-specific and stay in the consuming
repository.

## Requirements

- Rust target `wasm32-unknown-unknown`
- `wasm-bindgen` 0.2.129
- `wasm-opt` (binaryen)
- `brotli`
- `python3`
- optional: `esbuild` for JavaScript minification

## Versioning

Pin the submodule to a commit or tag. Updating is deliberate:

```bash
git submodule update --remote addons/bevy-douyin
git add addons/bevy-douyin
git commit -m "chore: bump bevy-douyin adapter"
```

## License

WTFPL, see `LICENSE`. The runtime and glue patch originate from
`pppkin/bevy_douyin`; this repository keeps only the reusable adapter pieces.
