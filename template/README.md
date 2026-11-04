# Platform template

Copy `package/` into your game repository (for example
`platforms/douyin/package/`) and replace the placeholders.

```bash
mkdir -p platforms/douyin/package
cp -R addons/bevy-douyin/template/package/. platforms/douyin/package/
```

The files are:

| File | What to change |
| --- | --- |
| `game.js` | `name`, `wasm`, `glue`, `AD_UNIT_ID`, optional `globalPrefix` / `storagePrefix` |
| `game.json` | orientation / status bar, if your game needs different behavior |
| `project.config.json` | `appid` and `projectname` |
| `icon.png` | add your own icon; the template intentionally ships none |

## `game.js`

- `name` is only the log prefix (`[bevy-douyin:<name>]`).
- `wasm` must match the build's `--name`: the output is `<name>.wasm.br`.
- `glue` must match the build's `--name`: the output is `<name>.js`.
- `--wasm` passed to `tools/build.sh` only selects the Rust artifact stem
  (`target/wasm32-unknown-unknown/release/<stem>.wasm`); it does not rename
  the JavaScript output.
- `AD_UNIT_ID` is your Douyin rewarded-video ad slot. Leave it empty to use the
  adapter's local mock flow: `RequestAd` returns a ticket, `AdStatus` goes
  `loading → ended` after `mockAdDelay` (600ms), and `AdResult` carries the
  same ticket. Use `mockAdResult` (`ended` / `skipped` / `error`) to test the
  failure paths, or `mockAds: false` to make an empty slot report
  `unavailable`.
- `storagePrefix` (optional, e.g. `'mygame.'`) namespaces `localStorage` and
  scopes `clear()`; without it the adapter only clears keys it wrote itself.
- `canvas` must match the selector the runtime should create (`#game-canvas`
  in this template); `width` / `height` are the logical resolution.
- `globalPrefix` defaults to `__bevy_douyin_`. If you change it, update the
  Rust host's global constant names too.

## Build output

The build writes `<name>.js`, `<name>.wasm.br`, `runtime/`, and `assets/`
next to `game.js`; it does not overwrite `game.js`, `game.json`,
`project.config.json`, or `icon.png`.

## Rust side

The Rust platform entry stays in the game repository, because it implements
the game's own host contract. The adapter exposes these globals under
`globalPrefix` (default `__bevy_douyin_`):

| Global | Direction | Meaning |
| --- | --- | --- |
| `Version` | JS -> Rust | adapter version (`"0.3.0"`) |
| `Layout` / `Canvas` / `SafeArea` | JS -> Rust | canvas, safe area, screen, seq (flat copies kept for 0.2) |
| `ViewportSeq` | JS -> Rust | bumps on canvas/safe-area changes |
| `Theme` / `ThemeManual` / `ThemeSource` | JS -> Rust | appearance state |
| `SetTheme(value)` / `FollowTheme()` | Rust -> JS | manual override / resume system |
| `RequestAd(kind)` | Rust -> JS | returns a ticket (`0` = busy/failed) |
| `ShowAd(kind)` | Rust -> JS | `RequestAd(kind) > 0` compatibility wrapper |
| `AdTicket` / `AdResult` | JS -> Rust | correlate a terminal result with its request |
| `AdStatus` / `AdReason` / `AdLastError` | JS -> Rust | state machine detail |
| `AppState` / `AppStateSeq` | JS -> Rust | foreground/background |
| `AdMock` | JS -> Rust | whether *this* ad used the local mock |

If you change `globalPrefix` in `game.js`, update the Rust host's constant
names too.
