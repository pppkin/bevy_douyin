'use strict';

// Node-only tests for the runtime adapter.  The adapter is plain ES5
// CommonJS, so we evaluate the real file in a fresh `vm` context per test and
// provide just enough of the Douyin host (`tt`) for `install()` to run.
//
//   node --test tests/
//
// These tests intentionally cover the contract consumers depend on:
// canvas sizing, safe area publication, the rewarded-ad state machine
// (real + mock), and storage.  They do not need a browser or DevTools.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'adapter.js'),
  'utf8'
);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHost(options) {
  const opts = options || {};
  const listeners = Object.create(null);
  const storage = Object.create(null);
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: 0,
    clientHeight: 0,
    addEventListener: function (type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    removeEventListener: function (type, fn) {
      const list = listeners[type];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    getContext: function () { return null; }
  };

  const tt = {
    getSystemInfoSync: function () {
      return Object.assign({
        windowWidth: 393,
        windowHeight: 852,
        theme: 'dark',
        platform: 'devtools'
      }, opts.systemInfo || {});
    },
    createCanvas: function () { return canvas; },
    getStorageInfoSync: function () {
      return { keys: Object.keys(storage) };
    },
    getStorageSync: function (key) {
      return storage[key] == null ? '' : storage[key];
    },
    setStorageSync: function (key, value) { storage[key] = String(value); },
    removeStorageSync: function (key) { delete storage[key]; },
    onTouchStart: function (fn) { listeners.touchstart = fn; },
    onTouchMove: function (fn) { listeners.touchmove = fn; },
    onTouchEnd: function (fn) { listeners.touchend = fn; },
    onTouchCancel: function (fn) { listeners.touchcancel = fn; }
  };

  if (typeof opts.adFactory === 'function') {
    tt.createRewardedVideoAd = opts.adFactory;
  }

  const GameGlobal = {
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: function () { return 0; },
    clearInterval: function () {},
    performance: { now: function () { return Date.now(); } }
  };

  const sandbox = {
    console: console,
    tt: tt,
    GameGlobal: GameGlobal,
    module: { exports: {} },
    exports: {},
    Promise: Promise
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'adapter.js' });

  const adapter = sandbox.module.exports;
  const env = adapter.install(Object.assign({
    name: 'test',
    width: 720,
    height: 1280,
    mockAdDelay: 10
  }, opts.cfg || {}));

  return {
    adapter: adapter,
    env: env,
    canvas: canvas,
    storage: storage,
    listeners: listeners,
    status: function () { return GameGlobal['__bevy_douyin_AdStatus']; },
    adMock: function () { return GameGlobal['__bevy_douyin_AdMock']; },
    canvasInfo: function () { return GameGlobal['__bevy_douyin_Canvas']; },
    safeArea: function () { return GameGlobal['__bevy_douyin_SafeArea']; },
    showAd: function (kind) {
      return GameGlobal['__bevy_douyin_ShowAd'](kind || 'rewarded');
    }
  };
}

test('publishes the adapter version', function () {
  const host = createHost();
  assert.equal(host.adapter.version, '0.2.2');
});

test('sizes the canvas to the screen aspect ratio and keeps CSS at W x H', function () {
  const host = createHost();
  assert.equal(host.canvasInfo().width, 720);
  assert.equal(host.canvasInfo().height, 1561);
  assert.equal(host.canvas.width, 720);
  assert.equal(host.canvas.height, 1561);
  assert.equal(host.canvas.style.width, '720px');
  assert.equal(host.canvas.style.height, '1561px');
});

test('devicePixelRatio only scales the backing store', function () {
  const host = createHost({ cfg: { devicePixelRatio: 2 } });
  assert.equal(host.canvasInfo().width, 720);
  assert.equal(host.canvasInfo().height, 1561);
  assert.equal(host.canvas.width, 1440);
  assert.equal(host.canvas.height, 3122);
  assert.equal(host.canvas.style.width, '720px');
});

test('publishes safe area in CSS pixels, including menuButton', function () {
  const host = createHost({
    systemInfo: {
      safeArea: { left: 0, top: 47, right: 393, bottom: 818 }
    },
    cfg: { screenWidth: 393, screenHeight: 852 }
  });
  const area = host.safeArea();
  assert.deepEqual(
    [area.left, area.top, area.right, area.bottom],
    [0, 47, 0, 34]
  );
  assert.equal(area.screenWidth, 393);
  assert.equal(area.screenHeight, 852);
});

test('mock ad: ended after the configured delay', async function () {
  const host = createHost();
  assert.equal(host.status(), 'idle');
  assert.equal(host.showAd(), true);
  assert.equal(host.status(), 'loading');
  assert.equal(host.adMock(), true);
  assert.equal(host.env.window['__bevy_douyin_AdMock'], true);
  await wait(40);
  assert.equal(host.status(), 'ended');
});

test('mock ad: skipped and error results are reachable', async function () {
  const skipped = createHost({ cfg: { mockAdResult: 'skipped' } });
  assert.equal(skipped.showAd(), true);
  await wait(40);
  assert.equal(skipped.status(), 'skipped');

  const failed = createHost({ cfg: { mockAdResult: 'error' } });
  assert.equal(failed.showAd(), true);
  await wait(40);
  assert.equal(failed.status(), 'error');
});

test('mock ad: unknown result falls back to ended', async function () {
  const host = createHost({ cfg: { mockAdResult: 'nonsense' } });
  assert.equal(host.showAd(), true);
  await wait(40);
  assert.equal(host.status(), 'ended');
});

test('mock ad: disabled with mockAds=false', function () {
  const host = createHost({ cfg: { mockAds: false } });
  assert.equal(host.showAd(), false);
  assert.equal(host.status(), 'unavailable');
});

test('real ad: close/error callbacks drive the status machine', function () {
  let close;
  let error;
  const host = createHost({
    adFactory: function () {
      return {
        onClose: function (fn) { close = fn; },
        onError: function (fn) { error = fn; },
        show: function () { return Promise.resolve(); },
        load: function () { return Promise.resolve(); }
      };
    },
    cfg: { adUnitId: 'test-unit' }
  });

  assert.equal(host.showAd(), true);
  assert.equal(host.status(), 'loading');
  assert.equal(host.adMock(), false);

  close({ isEnded: true });
  assert.equal(host.status(), 'ended');

  assert.equal(host.showAd(), true);
  close({ isEnded: false });
  assert.equal(host.status(), 'skipped');

  assert.equal(host.showAd(), true);
  error(new Error('no fill'));
  assert.equal(host.status(), 'error');
});

test('real ad: a configured unit that cannot be created reports error', function () {
  const host = createHost({
    adFactory: function () { throw new Error('ad unit rejected'); },
    cfg: { adUnitId: 'broken-unit' }
  });
  assert.equal(host.showAd(), false);
  assert.equal(host.status(), 'error');
});

test('storage reads and writes through tt storage', function () {
  const host = createHost();
  const win = host.env.window;
  win.localStorage.setItem('pong.best', '12');
  assert.equal(host.storage['pong.best'], '12');
  assert.equal(win.localStorage.getItem('pong.best'), '12');
  win.localStorage.removeItem('pong.best');
  assert.equal(host.storage['pong.best'], undefined);
  assert.equal(win.localStorage.getItem('pong.best'), null);
});
