'use strict';

// Node-only tests for the runtime adapter.  The adapter is plain ES5
// CommonJS, so we evaluate the real file in a fresh `vm` context per test and
// provide just enough of the Douyin host (`tt`) for `install()` to run.
//
//   node --test tests/
//
// These tests cover the contract consumers depend on: canvas sizing,
// viewport/safe-area publication, the theme and lifecycle state, the rewarded
// ad state machine (mock + real, tickets + timeout), and storage scoping.
// They do not need a browser or DevTools.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'adapter.js'),
  'utf8'
);

const PREFIX = '__bevy_douyin_';

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHost(options) {
  const opts = options || {};
  const listeners = Object.create(null);
  const storage = Object.assign(Object.create(null), opts.storage || {});
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

  const systemInfo = Object.assign({
    windowWidth: 393,
    windowHeight: 852,
    theme: 'dark',
    platform: 'devtools'
  }, opts.systemInfo || {});

  const tt = {
    getSystemInfoSync: function () {
      return Object.assign({}, systemInfo, opts.liveSystemInfo || {});
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
    onTouchCancel: function (fn) { listeners.touchcancel = fn; },
    onShow: function (fn) { listeners.show = fn; },
    onHide: function (fn) { listeners.hide = fn; },
    onWindowResize: function (fn) { listeners.resize = fn; },
    onThemeChange: function (fn) { listeners.themechange = fn; }
  };

  if (opts.menuButton !== undefined) {
    tt.getMenuButtonBoundingClientRect = function () { return opts.menuButton; };
  }
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
    mockAdDelay: 10,
    adTimeoutMs: 80
  }, opts.cfg || {}, opts.storagePrefix ? { storagePrefix: opts.storagePrefix } : {}));

  function pub(name) {
    return GameGlobal[PREFIX + name];
  }

  return {
    adapter: adapter,
    env: env,
    canvas: canvas,
    storage: storage,
    listeners: listeners,
    systemInfo: systemInfo,
    pub: pub,
    status: function () { return pub('AdStatus'); },
    adMock: function () { return pub('AdMock'); },
    ticket: function () { return pub('AdTicket'); },
    result: function () { return pub('AdResult'); },
    lastError: function () { return pub('LastError'); },
    canvasInfo: function () { return pub('Canvas'); },
    safeArea: function () { return pub('SafeArea'); },
    layout: function () { return pub('Layout'); },
    showAd: function (kind) { return pub('ShowAd')(kind || 'rewarded'); },
    requestAd: function (kind) { return pub('RequestAd')(kind || 'rewarded'); }
  };
}

test('publishes the adapter version and static config', function () {
  const host = createHost();
  assert.equal(host.adapter.version, '0.3.0');
  assert.equal(host.pub('Version'), '0.3.0');
  const cfg = host.pub('Config');
  assert.equal(cfg.name, 'test');
  assert.equal(cfg.designWidth, 720);
  assert.equal(cfg.adTimeoutMs, 80);
  assert.equal(cfg.mockAds, true);
  assert.equal(cfg.adUnitConfigured, false);
  assert.equal(host.lastError(), '');
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

test('publishes safe area in CSS pixels, including normalised menuButton', function () {
  const host = createHost({
    systemInfo: {
      safeArea: { left: 0, top: 47, right: 393, bottom: 818 },
      statusBarHeight: 47
    },
    menuButton: { left: 296, top: 50, right: 383, bottom: 82 },
    cfg: { screenWidth: 393, screenHeight: 852 }
  });
  const area = host.safeArea();
  assert.deepEqual(
    [area.left, area.top, area.right, area.bottom],
    [0, 47, 0, 34]
  );
  assert.equal(area.screenWidth, 393);
  assert.equal(area.screenHeight, 852);
  assert.equal(area.statusBarHeight, 47);
  assert.equal(area.width, 393);
  assert.equal(area.height, 771);
  assert.equal(area.hasMenuButton, true);
  assert.deepEqual(plain(area.menuButton), {
    left: 296, top: 50, right: 383, bottom: 82, width: 87, height: 32
  });
});

test('menuButton is null on hosts that do not expose it', function () {
  const host = createHost();
  const area = host.safeArea();
  assert.equal(area.menuButton, null);
  assert.equal(area.hasMenuButton, false);
});

test('viewport sequence bumps and host size updates after resize', function () {
  const host = createHost();
  assert.equal(host.pub('ViewportSeq'), 1);
  assert.equal(host.layout().seq, 1);

  host.systemInfo.windowWidth = 500;
  host.systemInfo.windowHeight = 500;
  host.listeners.resize();

  assert.equal(host.pub('ViewportSeq'), 2);
  assert.equal(host.layout().seq, 2);
  assert.equal(host.canvasInfo().width, 1280);
  assert.equal(host.canvasInfo().height, 1280);
  assert.equal(host.canvas.width, 1280);
  assert.equal(host.canvas.style.width, '1280px');
  assert.equal(host.env.window.innerWidth, 1280);
  assert.equal(host.layout().screen.width, 500);
});

test('theme: manual choice sticks, FollowTheme resumes the system', function () {
  const host = createHost();
  assert.equal(host.pub('Theme'), 'dark');
  assert.equal(host.pub('ThemeManual'), false);
  assert.equal(host.pub('ThemeSource'), 'system');

  host.pub('SetTheme')('light');
  assert.equal(host.pub('Theme'), 'light');
  assert.equal(host.pub('ThemeManual'), true);
  assert.equal(host.pub('ThemeSource'), 'manual');

  // A system appearance change must not undo an explicit choice.
  host.listeners.themechange({ theme: 'dark' });
  assert.equal(host.pub('Theme'), 'light');

  host.systemInfo.theme = 'light';
  host.pub('FollowTheme')();
  assert.equal(host.pub('Theme'), 'light');
  assert.equal(host.pub('ThemeManual'), false);
  assert.equal(host.pub('ThemeSource'), 'system');

  host.listeners.themechange({ theme: 'dark' });
  assert.equal(host.pub('Theme'), 'dark');
});

test('lifecycle publishes foreground/background with a sequence', function () {
  const host = createHost();
  assert.equal(host.pub('AppState'), 'foreground');
  assert.equal(host.pub('AppStateSeq'), 1);

  host.listeners.hide();
  assert.equal(host.pub('AppState'), 'background');
  assert.equal(host.pub('AppStateSeq'), 2);

  host.listeners.show();
  assert.equal(host.pub('AppState'), 'foreground');
  assert.equal(host.pub('AppStateSeq'), 3);
});

test('mock ad: ticket, result and ended after the configured delay', async function () {
  const host = createHost();
  assert.equal(host.status(), 'idle');
  assert.equal(host.result(), null);

  assert.equal(host.requestAd(), 1);
  assert.equal(host.ticket(), 1);
  assert.equal(host.status(), 'loading');
  assert.equal(host.adMock(), true);
  assert.equal(host.env.window[PREFIX + 'AdMock'], true);

  await wait(40);
  assert.equal(host.status(), 'ended');
  assert.deepEqual(plain(host.result()), {
    ticket: 1, kind: 'rewarded', status: 'ended', reason: 'mock',
    isEnded: true, mock: true
  });
});

test('mock ad: skipped and error results are reachable', async function () {
  const skipped = createHost({ cfg: { mockAdResult: 'skipped' } });
  assert.equal(skipped.requestAd(), 1);
  await wait(40);
  assert.equal(skipped.status(), 'skipped');
  assert.equal(skipped.result().isEnded, false);

  const failed = createHost({ cfg: { mockAdResult: 'error' } });
  assert.equal(failed.requestAd(), 1);
  await wait(40);
  assert.equal(failed.status(), 'error');
  assert.equal(failed.pub('AdLastError'), 'mock');
});

test('mock ad: unknown result falls back to ended', async function () {
  const host = createHost({ cfg: { mockAdResult: 'nonsense' } });
  assert.equal(host.requestAd(), 1);
  await wait(40);
  assert.equal(host.status(), 'ended');
});

test('mock ad: disabled with mockAds=false', function () {
  const host = createHost({ cfg: { mockAds: false } });
  assert.equal(host.requestAd(), 0);
  assert.equal(host.showAd(), false);
  assert.equal(host.status(), 'unavailable');
  assert.equal(host.result(), null);
});

test('ad: a second request while one is pending is rejected', async function () {
  const host = createHost({ cfg: { mockAdDelay: 30 } });
  assert.equal(host.requestAd(), 1);
  assert.equal(host.requestAd(), 0);
  assert.equal(host.ticket(), 1);
  await wait(50);
  assert.equal(host.requestAd(), 2);
  await wait(50);
  assert.equal(host.result().ticket, 2);
});

test('ad: the adapter enforces its own timeout', async function () {
  const host = createHost({ cfg: { mockAdDelay: 200, adTimeoutMs: 20 } });
  assert.equal(host.requestAd(), 1);
  await wait(50);
  assert.equal(host.status(), 'error');
  assert.equal(host.pub('AdLastError'), 'timeout');
  assert.equal(host.result().reason, 'timeout');
  assert.equal(host.result().ticket, 1);
  // The late mock callback must not overwrite the terminal result.
  await wait(200);
  assert.equal(host.status(), 'error');
  assert.equal(host.result().ticket, 1);
});

test('real ad: close/error callbacks drive the ticket state machine', function () {
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

  assert.equal(host.requestAd(), 1);
  assert.equal(host.status(), 'loading');
  assert.equal(host.adMock(), false);

  close({ isEnded: true });
  assert.equal(host.status(), 'ended');
  assert.equal(host.result().mock, false);
  assert.equal(host.result().ticket, 1);

  assert.equal(host.requestAd(), 2);
  close({ isEnded: false });
  assert.equal(host.status(), 'skipped');
  assert.equal(host.result().ticket, 2);
  assert.equal(host.result().isEnded, false);

  assert.equal(host.requestAd(), 3);
  error(new Error('no fill'));
  assert.equal(host.status(), 'error');
  assert.equal(host.pub('AdLastError'), 'runtime');
  assert.equal(host.result().ticket, 3);
});

test('real ad: a configured unit that cannot be created reports error', function () {
  const host = createHost({
    adFactory: function () { throw new Error('ad unit rejected'); },
    cfg: { adUnitId: 'broken-unit' }
  });
  assert.equal(host.requestAd(), 0);
  assert.equal(host.showAd(), false);
  assert.equal(host.status(), 'error');
  assert.equal(host.result(), null);
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

test('storage prefix isolates keys and clear only drops that namespace', function () {
  const host = createHost({
    storagePrefix: 'pong.',
    storage: { 'pong.best': '12', foreign: 'keep' }
  });
  const win = host.env.window;
  assert.equal(win.localStorage.getItem('best'), '12');
  assert.equal(win.localStorage.getItem('foreign'), null);

  win.localStorage.setItem('wins', '3');
  assert.equal(host.storage['pong.wins'], '3');
  assert.equal(host.storage['pong.best'], '12');

  win.localStorage.clear();
  assert.equal(host.storage['pong.best'], undefined);
  assert.equal(host.storage['pong.wins'], undefined);
  assert.equal(host.storage.foreign, 'keep');
});

test('storage clear without a prefix leaves foreign keys alone', function () {
  const host = createHost({
    storage: { foreign: 'keep', 'game.a': '1' }
  });
  const win = host.env.window;
  assert.equal(win.localStorage.getItem('game.a'), '1');
  win.localStorage.setItem('game.b', '2');
  win.localStorage.clear();
  assert.equal(host.storage.foreign, 'keep');
  assert.equal(host.storage['game.a'], '1');
  assert.equal(host.storage['game.b'], undefined);
});
