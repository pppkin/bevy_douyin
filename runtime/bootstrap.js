/*
 * Bevy/Douyin bootstrap
 * ---------------------
 * Installs the runtime adapter, then loads and starts a wasm-bindgen
 * `--target no-modules` glue module.  The glue is passed as a function so it
 * is required only after the DOM/WebGL shims exist:
 *
 *   var runtime = require('./runtime/bootstrap.js');
 *   runtime.start({
 *     width: 1280,
 *     height: 720,
 *     wasm: 'game.wasm.br',
 *     glue: function () { return require('./game.js'); }
 *   });
 */
(function () {
  'use strict';

  var adapter = require('./adapter.js');

  function start(options) {
    var cfg = options || {};
    var env = adapter.install(cfg);

    if (typeof cfg.glue !== 'function') {
      throw new Error('[bevy-douyin] start() needs glue: function () { return require("./<name>.js"); }');
    }

    var wasmPath = cfg.wasm || 'game.wasm.br';
    env.log('booting ' + wasmPath);

    var glueModule;
    try {
      glueModule = cfg.glue();
    } catch (e) {
      env.fail('require glue', e);
      throw e;
    }

    var boot;
    try {
      boot = glueModule({ module_or_path: wasmPath });
    } catch (e) {
      env.fail('start wasm', e);
      throw e;
    }

    if (env.global) env.global.__bevyBoot = boot;

    if (typeof boot.then === 'function') {
      boot.then(function () {
        env.log('wasm started (Rust main returned)');
        if (typeof cfg.onReady === 'function') {
          try { cfg.onReady(env); } catch (e) { env.fail('onReady', e); }
        }
      }).catch(function (e) {
        env.fail('wasm boot failed', e);
        if (env.global) env.global.__bevyBootError = String(e);
        if (typeof cfg.onError === 'function') {
          try { cfg.onError(e); } catch (_) {}
        }
      });
    } else {
      env.log('wasm started synchronously');
      if (typeof cfg.onReady === 'function') {
        try { cfg.onReady(env); } catch (e) { env.fail('onReady', e); }
      }
    }

    return boot;
  }

  module.exports = {
    version: adapter.version,
    install: adapter.install,
    start: start
  };
})();
