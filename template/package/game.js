// Minimal Douyin mini-game entry. Copy this file into your package directory
// and replace the placeholders (name / wasm / glue / AD_UNIT_ID).
var runtime = require('./runtime/bootstrap.js');

var AD_UNIT_ID = ''; // set to your rewarded-video ad unit, or leave empty for the mock flow

runtime.start({
  name: 'my-game',
  canvas: '#game-canvas',
  width: 720,
  wasm: 'my_game.wasm.br',
  adUnitId: AD_UNIT_ID,
  globalPrefix: '__bevy_douyin_', // must match the Rust host
  glue: function () { return require('./my_game.js'); }
});
