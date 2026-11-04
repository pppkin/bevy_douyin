# Changelog

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
