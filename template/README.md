# Platform template

Copy `package/` into your game repository (for example
`platforms/douyin/package/`) and replace the placeholders:

- `name` in `game.js` is only the log prefix.
- `wasm` and `glue` must match the `--wasm` / `--name` values passed to
  `tools/build.sh`.
- `AD_UNIT_ID` is your Douyin rewarded-video ad slot; leave it empty to use the
  adapter's local mock flow.
- `project.config.json` needs the real appid from the Douyin developer console.

The Rust platform entry stays in the game repository, because it implements
the game's own host contract. The adapter exposes these globals under
`globalPrefix` (default `__bevy_douyin_`):

| Global | Direction | Meaning |
| --- | --- | --- |
| `Canvas` | JS -> Rust | logical canvas size `{ width, height }` |
| `SafeArea` | JS -> Rust | safe-area insets + screen size + menu button |
| `Theme` | both | `"dark"` / `"light"` |
| `SetTheme(value)` | Rust -> JS | manual appearance override |
| `AdStatus` | JS -> Rust | `idle` / `loading` / `ended` / `skipped` / `error` / `unavailable` |
| `ShowAd(kind)` | Rust -> JS | start a rewarded video; `false` means use the game mock |

If you change `globalPrefix` in `game.js`, update the Rust host's constant
names too.
