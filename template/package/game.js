// Minimal Douyin mini-game entry. Copy this file into your package directory
// and replace the placeholders (name / wasm / glue / AD_UNIT_ID).
var runtime = require('./runtime/bootstrap.js');

// Set to your rewarded-video ad unit. When empty the adapter runs a local
// mock: AdStatus goes loading -> ended (600ms), so the simulator can exercise
// the reward flow without a real ad slot.
var AD_UNIT_ID = '';

runtime.start({
  name: 'my-game',
  canvas: '#game-canvas',
  width: 720,
  wasm: 'my_game.wasm.br',
  adUnitId: AD_UNIT_ID,
  globalPrefix: '__bevy_douyin_', // must match the Rust host
  glue: function () { return require('./my_game.js'); }
});
