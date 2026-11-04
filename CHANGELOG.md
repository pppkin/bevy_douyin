# Changelog

## 0.4.0

### Added

- WebAudio output for `bevy_audio`. The adapter installs a global
  `AudioContext` backed by `tt.getAudioContext()` (base library 1.34.0+), with a
  native `AudioContext` fallback in the simulator.
- `destination.setChannelCount` polyfill for Douyin's AudioContext.
- Automatic audio lifecycle: touch start resumes a suspended context, `onShow`
  resumes and `onHide` suspends it.
- Two new adapter tests (21 total) covering the shim, the channel-count
  polyfill, touch unlock and foreground/background transitions.

### Notes

- Small sounds should be embedded with `include_bytes!`: Douyin package files
  cannot be read through `fetch` or `FileSystemManager`.
- Device audio is API-verified only; test mute switches and headphones on real
  hardware.

## 0.3.0

### Added

- `Version`, `Config`, `Layout` and `ViewportSeq` globals. `Layout` bundles
  canvas, safe area, screen size and device pixel ratio in one stable object.
- Runtime viewport refresh on `tt.onWindowResize`: the adapter recomputes the
  canvas/safe area, resizes the backing store, updates `window.innerWidth/Height`
  and `screen`, republishes `Canvas`/`SafeArea`/`Layout`, bumps `ViewportSeq`
  and dispatches `resize`.
- `SafeArea` now exposes `width`, `height`, `statusBarHeight`, `hasMenuButton`
  and a normalised `menuButton` (`{left,top,right,bottom,width,height}` or null).
- `ThemeManual` and `ThemeSource`. `FollowTheme()` resumes system appearance;
  `SetTheme()` now keeps the manual choice across system changes.
- Ticket-based ads: `RequestAd(kind)` returns a ticket, and `AdResult`
  (`{ticket,kind,status,reason,isEnded,mock}`) lets games correlate callbacks.
  `ShowAd(kind)` remains as a boolean compatibility wrapper.
- Adapter-side ad timeout (`adTimeoutMs`, default 30s) publishes
  `status=error`, `reason=timeout`.
- `AppState` / `AppStateSeq` for foreground/background transitions.
- `storagePrefix` namespaces storage; `clear()` is scoped to that prefix (or,
  without one, to keys written through the adapter). Foreign host keys and
  `__boot_notes` are preserved.
- `LastError`, `AdReason` and `AdLastError` for diagnostics.
- Tests expanded to 19 cases covering the new viewport, theme, lifecycle,
  ticket/timeout and storage-scoping behaviour.

### Changed

- `AdMock` now describes the current/last ad only; use `Config.mockAds` to
  check whether the mock is enabled.
- `SetTheme` no longer lets `tt.onThemeChange` silently clear the manual
  override; call `FollowTheme()` explicitly.
- Theme check interval is documented as 4s (the adapter already used 4s).

### Fixed

- `clear()` no longer wipes every key previously loaded from host storage.
- A late mock-ad timer or an old real-ad callback can no longer overwrite a
  newer ticket's result.
- Occupied ad state now returns `0` from `RequestAd` instead of starting a
  second request.

## 0.2.2

### Added

- Local rewarded-ad mock when no `adUnitId` is configured (or the host has no
  `tt.createRewardedVideoAd`): `ShowAd` returns `true`, `AdStatus` goes
  `loading → ended` after `mockAdDelay` (600ms). Configure with `mockAds`,
  `mockAdResult` (`ended` / `skipped` / `error`) and `mockAdDelay`.
- `AdMock` global: whether the last `ShowAd` used the mock.
- `docs/host-contract.md`: globals, units, pointer pipeline, theme, ads,
  storage, lifecycle and an upgrade checklist.
- Restored `docs/how-it-works.md`, `docs/troubleshooting.md` and
  `docs/wasm-size.md` from `starter-v1`, updated for the adapter layout.
- Node contract tests (`npm test` / `node --test tests/`) covering canvas
  sizing, DPR, safe area, the mock/real ad state machine and storage.

### Fixed

- `ShowAd` with a configured but unusable ad unit now reports `error`
  instead of `unavailable`.
- README no longer claims the game's `Host` owns the `tt.*` calls; the adapter
  does, and Rust reads the published globals through `window`.
- Template no longer promises a mock that did not exist; the mock is now real.

### Notes

- The adapter still has no built-in timeout for real ads. Consumers must bound
  the `loading` state (15–30s recommended); see `docs/host-contract.md`.
