/*
 * Bevy/Douyin runtime adapter
 * ---------------------------
 * Installs the smallest browser-shaped environment that Bevy 0.20 (winit +
 * wgpu/WebGL2) needs inside a Douyin mini-game.  It is deliberately a plain
 * ES5 CommonJS module: the mini-game runtime does not always ship modern DOM
 * or module support, and this file is loaded before the wasm glue.
 *
 * Usage:
 *   var adapter = require('./runtime/adapter.js');
 *   var env = adapter.install({ width: 1280, height: 720, canvas: '#game' });
 *   // then load the wasm-bindgen glue and call it with a package path
 *
 * See ../README.md for the supported surface and known limitations.
 */
(function () {
  'use strict';

  var G = typeof GameGlobal !== 'undefined'
    ? GameGlobal
    : (typeof globalThis !== 'undefined' ? globalThis : this);

  var VERSION = '0.2.2';
  var DEFAULT_GLOBAL_PREFIX = '__bevy_douyin_';
  var installed = null;

  function describeError(e) {
    if (!e) return String(e);
    return e.stack || e.message || String(e);
  }

  function install(options) {
    if (installed) return installed;

    var cfg = options || {};
    var globalPrefix = cfg.globalPrefix ? String(cfg.globalPrefix) : DEFAULT_GLOBAL_PREFIX;

    // Publish host facts under a configurable namespace.  The Rust host reads
    // these names back through `window` (and GameGlobal is kept in sync for
    // device harnesses).  Games that embed more than one runtime can override
    // `globalPrefix` instead of colliding on process-wide globals.
    function publish(name, value) {
      var key = globalPrefix + name;
      try { G[key] = value; } catch (e) {}
      try { if (typeof win !== 'undefined') win[key] = value; } catch (e) {}
    }

    var canvasSelector = cfg.canvas || '#bevy-canvas';
    var devicePixelRatio = Number(cfg.devicePixelRatio) || 1;

    var sysInfo = {};
    try { sysInfo = tt.getSystemInfoSync() || {}; } catch (e) {}
    var designW = Number(cfg.width) || 1280;
    var designH = Number(cfg.height) || 1280;
    var screenW = Number(cfg.screenWidth) || Number(sysInfo.windowWidth) || designW;
    var screenH = Number(cfg.screenHeight) || Number(sysInfo.windowHeight) || designH;
    // The canvas must share the screen's aspect ratio: the host scales the
    // main canvas to fill the screen, so a fixed 720x1280 buffer would be
    // stretched (and the Rust camera would have to letterbox or distort).
    // Tall phones keep the design width and gain height; wide screens
    // (tablets, split view) keep the design height and gain width.
    var W = Math.round(Math.max(designW, designH * screenW / screenH));
    var H = Math.round(Math.max(designH, designW * screenH / screenW));

    // Safe-area rectangle, in CSS pixels. Douyin exposes status-bar and
    // home-indicator bounds through getSystemInfoSync().safeArea. If a host
    // does not provide them, use a conservative phone-shaped default.
    function finite(value, fallback) {
      return typeof value === 'number' && isFinite(value) ? value : fallback;
    }
    var safeInfo = sysInfo.safeArea || {};
    var safeLeft = finite(safeInfo.left, screenW * 0.02);
    var safeTop = finite(safeInfo.top, screenH * 0.045);
    var safeRight = finite(safeInfo.right, screenW * 0.98);
    var safeBottom = finite(safeInfo.bottom, screenH * 0.965);
    var menuButton = null;
    try {
      if (typeof tt.getMenuButtonBoundingClientRect === 'function') {
        menuButton = tt.getMenuButtonBoundingClientRect();
      }
    } catch (e) {}
    var safeArea = {
      left: Math.max(0, Math.min(safeLeft, screenW * 0.12)),
      top: Math.max(0, Math.min(safeTop, screenH * 0.18)),
      right: Math.max(0, Math.min(screenW - safeRight, screenW * 0.12)),
      bottom: Math.max(0, Math.min(screenH - safeBottom, screenH * 0.18)),
      screenWidth: screenW,
      screenHeight: screenH,
      menuButton: menuButton
    };

    // Day/night appearance. Douyin reports the host appearance on the same
    // system-info object on current clients; older hosts simply fall back to
    // the night theme. The value is exposed to Rust as a string property.
    var currentTheme = 'dark';
    var manualTheme = null;
    function systemTheme() {
      try {
        var info = tt.getSystemInfoSync() || {};
        var value = info.theme || info.themeMode || info.colorScheme;
        if (value) return String(value).toLowerCase() === 'light' ? 'light' : 'dark';
      } catch (e) {}
      return null;
    }
    function publishTheme() {
      publish('Theme', currentTheme);
    }
    function setTheme(value) {
      var next = String(value || '').toLowerCase() === 'light' ? 'light' : 'dark';
      if (next === currentTheme) return;
      currentTheme = next;
      publishTheme();
      log('theme: ' + currentTheme);
    }
    currentTheme = systemTheme() || 'dark';
    publishTheme();

    var prefix = '[bevy-douyin' + (cfg.name ? ':' + cfg.name : '') + ']';
    var logs = [];
    // Durable copy of the boot log.  On a real device the page can be torn
    // down mid-boot, taking `console` with it; storage survives, so the next
    // launch can show what the previous one did.
    function persist(text) {
      try {
        if (typeof tt === 'undefined' || !tt.setStorageSync) return;
        var arr = tt.getStorageSync('__boot_notes');
        if (!arr || typeof arr !== 'object') arr = [];
        arr.push(text);
        while (arr.length > 60) arr.shift();
        tt.setStorageSync('__boot_notes', arr);
      } catch (e) {}
    }
    function log(message) {
      var text = String(message);
      logs.push(text);
      if (logs.length > 200) logs.shift();
      persist(text);
      if (typeof cfg.log === 'function') {
        try { cfg.log(text); return; } catch (e) {}
      }
      try { console.log(prefix + ' ' + text); } catch (e) {}
    }
    function fail(where, e) {
      var text = where + ': ' + describeError(e);
      log('ERROR ' + text);
      try { console.error(prefix + ' ' + text); } catch (_) {}
    }
    // Device probes are opt-in: the harness sets `GameGlobal.__probe = 1`
    // *before* installing the adapter.  Off by default, so a shipped build
    // keeps its console quiet and does no per-frame readPixels.
    // `trace` is for heartbeats and one-off samples; `log` stays for real
    // failures (GLSL compile errors, context loss, ad errors).
    var PROBE = !!(cfg.probe || (G && G.__probe));
    function trace(message) {
      if (PROBE) log(message);
    }
    log('safe area: top=' + safeArea.top.toFixed(1) + ' bottom=' + safeArea.bottom.toFixed(1) +
      ' left=' + safeArea.left.toFixed(1) + ' right=' + safeArea.right.toFixed(1));
    try {
      var si = (typeof tt !== 'undefined' && tt.getSystemInfoSync) ? tt.getSystemInfoSync() : {};
      log('device: ' + [si.platform, si.system, si.model, si.brand,
        'sdk=' + si.SDKVersion, 'mem=' + si.memorySize + 'MB'].join(' | '));
    } catch (e) {
      log('device info unavailable: ' + e);
    }
    publish('SafeArea', safeArea);
    // Canvas size in design pixels; the Rust side creates its window with
    // exactly these dimensions (see `safe_area::design_viewport`).
    publish('Canvas', { width: W, height: H });

    if (typeof tt === 'undefined' || typeof tt.createCanvas !== 'function') {
      throw new Error(prefix + ' tt.createCanvas is unavailable: not a Douyin mini-game?');
    }

    // ── real canvas ──────────────────────────────────────────────────────────
    // CSS size stays W×H; the backing store can be larger for HiDPI. The
    // default is 1 because it is the path verified in the simulator; set
    // `devicePixelRatio: 2` explicitly after testing the target devices.
    var realCanvas = tt.createCanvas();
    realCanvas.width = Math.round(W * devicePixelRatio);
    realCanvas.height = Math.round(H * devicePixelRatio);

    var style = {
      width: W + 'px',
      height: H + 'px',
      display: 'block',
      position: 'absolute',
      left: '0px',
      top: '0px',
      setProperty: function (k, v) { this[k] = v; },
      removeProperty: function (k) { delete this[k]; },
      getPropertyValue: function (k) { return this[k] == null ? '' : String(this[k]); }
    };
    try {
      Object.defineProperty(realCanvas, 'style', {
        configurable: true,
        get: function () { return style; }
      });
    } catch (e) {
      log('cannot override canvas.style: ' + e);
    }

    var listeners = Object.create(null);
    function listen(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    }
    function unlisten(type, fn) {
      var a = listeners[type];
      if (!a) return;
      var i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    }


    // Independent of bevy/wgpu: clear the buffer to magenta with raw GL and
    // read it straight back.  If this is not magenta, the context itself is a
    // stub (or the canvas is not the one on screen) and nothing above it can
    // ever appear.

    var lastClear = 'none';
    var clearCalls = 0;
    var realClears = 0;
    // Record what the renderer actually asks for.  This separates "bevy clears
    // to transparent black (alpha/compositing problem)" from "bevy clears to
    // magenta but something else wipes it".
    function watchClear(ctx) {
      try {
        var orig = ctx.clearColor;
        if (typeof orig === 'function') {
          ctx.clearColor = function (r, g, b, a) {
            if (!inProbe) {
              realClears++;
              lastClear = r + ',' + g + ',' + b + ',' + a;
              if (realClears <= 3) {
                var st = '';
                try { st = String(new Error().stack).split('\n')[2] || ''; } catch (_) {}
                trace('gl.clearColor #' + realClears + ' = ' + lastClear +
                    ' <- ' + st.replace(/\s+/g, ' ').slice(0, 80));
              }
            }
            clearCalls++;
            return orig.apply(ctx, arguments);
          };
        }
        var origClear = ctx.clear;
        if (typeof origClear === 'function') {
          ctx.clear = function () {
            clearCalls++;
            return origClear.apply(ctx, arguments);
          };
        }
      } catch (e) {
        fail('watchClear', e);
      }
    }

    function glSelfTest(ctx, kind) {
      inProbe = true;
      try {
        var w = ctx.drawingBufferWidth || 0;
        var h = ctx.drawingBufferHeight || 0;
        ctx.clearColor(1, 0, 1, 1);
        ctx.clear(ctx.COLOR_BUFFER_BIT);
        var px = new Uint8Array(4);
        ctx.readPixels(Math.min(4, w - 1), Math.min(4, h - 1), 1, 1,
                       ctx.RGBA, ctx.UNSIGNED_BYTE, px);
        log('gl selftest ' + kind + ' db=' + w + 'x' + h +
            ' px=' + px[0] + ',' + px[1] + ',' + px[2] + ',' + px[3]);
      } catch (e) {
        fail('glSelfTest', e);
      }
      inProbe = false;
    }

    var webgl2 = null;
    var glType = null;
    var contextRequested = false;
    var used2d = false;
    // Douyin's canvas rejects some attribute dictionaries outright on device
    // (the native shim throws instead of returning null).  Try the requested
    // attributes first, then progressively simpler shapes, and log every
    // outcome so the device log says exactly what the platform accepts.
    function sanitizeAttrs(attrs) {
      if (!attrs) return undefined;
      var keep = ['alpha', 'depth', 'stencil', 'antialias', 'premultipliedAlpha',
                  'preserveDrawingBuffer', 'powerPreference',
                  'failIfMajorPerformanceCaveat'];
      var out = {};
      var any = false;
      for (var i = 0; i < keep.length; i++) {
        if (attrs[keep[i]] !== undefined) { out[keep[i]] = attrs[keep[i]]; any = true; }
      }
      return any ? out : undefined;
    }


    // wgpu's GL backend compiles programs lazily and, when a program fails, it
    // only reports "RenderPipeline ... is invalid" at set_pipeline time with no
    // detail.  Wrap the compile/link entry points so the driver's own error log
    // (the actual GLSL diagnostic) is captured.
    function instrumentGL(gl) {
      if (!gl || gl.__instrumented) return;
      gl.__instrumented = true;
      try {
        var compile = gl.compileShader;
        if (compile) {
          gl.compileShader = function (sh) {
            compile.call(gl, sh);
            try {
              if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                var info = String(gl.getShaderInfoLog(sh));
                var src = String(gl.getShaderSource(sh));
                log('GLSL compile FAILED: ' + info.slice(0, 300));
                var m = /0:(\d+)/.exec(info);
                if (m) {
                  var lines = src.split('\n');
                  var n = parseInt(m[1], 10);
                  log('GLSL ctx: ' + lines.slice(Math.max(0, n - 2), n + 2)
                        .map(function (l) { return l.trim(); }).join(' | ').slice(0, 300));
                }
                // GLSL ES 3.00 reserves `smooth`, and the iOS GL translation
                // layer rejects it outright ("'smooth' : syntax error").  naga
                // emits it as an interpolation qualifier, which is a no-op for
                // default interpolation, so stripping it is safe.
                var fixed = src.replace(/\bsmooth\b(?!step)\s+/g, '');
                if (fixed !== src) {
                  gl.shaderSource(sh, fixed);
                  compile.call(gl, sh);
                  log('GLSL retry without "smooth": ' +
                      (gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? 'OK'
                        : 'FAILED ' + String(gl.getShaderInfoLog(sh)).slice(0, 200)));
                }
              }
            } catch (_) {}
          };
        }
        var link = gl.linkProgram;
        if (link) {
          gl.linkProgram = function (pr) {
            link.call(gl, pr);
            try {
              if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) {
                log('GLSL link FAILED: ' + String(gl.getProgramInfoLog(pr)).slice(0, 500));
              }
            } catch (_) {}
          };
        }
      } catch (e) {
        fail('instrumentGL', e);
      }
    }

    function getContext(type, attrs) {
      if (type === '2d') {
        // A canvas can only ever have ONE context type.  If something grabs 2d
        // first, the later webgl2 context exists but renders nowhere - which is
        // exactly the "drawing buffer is all zeros" symptom on device.
        try {
          var c2 = realCanvas.getContext('2d', attrs);
          if (!used2d) {
            used2d = true;
            trace('2d getContext -> ' + (c2 ? 'OK (canvas is now 2d-bound!)' : 'NULL'));
          }
          return c2;
        } catch (e) {
          fail('2d getContext', e);
          return null;
        }
      }
      if (webgl2) return webgl2;
      if (contextRequested) return webgl2;
      contextRequested = true;

      var wanted = String(type || 'webgl2');
      var clean = sanitizeAttrs(attrs);
      // Douyin's native canvas throws when the attribute dictionary contains
      // anything its shim does not know (wgpu passes desynchronized /
      // xrCompatible / ...), so an argument-less call must come first:
      //   ERROR getContext("webgl2"): @ttjssdk:///tmg-core.js ...
      //   WebGL try webgl2(bare): OK
      // The throw is nondeterministic: the same bare call succeeds on one run
      // and throws on the next, so every variant is tried more than once.
      var attempts = [];
      for (var r = 0; r < 3; r++) {
        attempts.push([wanted, undefined]);
        if (clean) attempts.push([wanted, clean]);
        if (wanted !== 'webgl') {
          attempts.push(['webgl', undefined]);
          if (clean) attempts.push(['webgl', clean]);
        }
      }

      for (var k = 0; k < attempts.length; k++) {
        var t = attempts[k][0];
        var a = attempts[k][1];
        try {
          var ctx = a ? realCanvas.getContext(t, a) : realCanvas.getContext(t);
          trace('WebGL try ' + t + (a ? '(attrs)' : '(bare)') + ': ' + (ctx ? 'OK' : 'NULL'));
          if (ctx) {
            webgl2 = ctx;
            glType = t;
            try {
              trace('WebGL ' + t + ' version=' + ctx.getParameter(ctx.VERSION) +
                  ' maxTex=' + ctx.getParameter(ctx.MAX_TEXTURE_SIZE) +
                  ' lost=' + (ctx.isContextLost ? ctx.isContextLost() : '?') +
                  ' used2d=' + used2d);
            } catch (_) {}
            instrumentGL(ctx);
            if (PROBE) {
              watchClear(ctx);
              glSelfTest(ctx, t);
            }
            return ctx;
          }
        } catch (e) {
          fail('getContext("' + t + '")', e);
        }
      }
      webgl2 = null;
      fail('no WebGL context (tried ' + attempts.length + ' variants for "' + wanted + '")', null);
      return webgl2;
    }


    // Read back a few pixels straight from the drawing buffer.  This is the
    // only way to tell "we render but the platform never shows the canvas"
    // apart from "we never render at all": ClearColor is magenta, so a
    // magenta sample here means the WebGL side is fine.
    function samplePixels(glFrame) {
      try {
        // wgpu-webgl leaves its own framebuffer bound after a frame, so a
        // plain readPixels() samples an unresolved FBO and always returns
        // zeros.  Bind the default framebuffer first.
        try { webgl2.bindFramebuffer(webgl2.FRAMEBUFFER, null); } catch (_) {}
        var w = webgl2.drawingBufferWidth || 0;
        var h = webgl2.drawingBufferHeight || 0;
        var pts = [[4, 4], [(w / 2) | 0, (h / 2) | 0], [Math.max(0, w - 4), Math.max(0, h - 4)]];
        var px = new Uint8Array(4);
        var out = 'pix db=' + w + 'x' + h + ' css=' + realCanvas.width + 'x' + realCanvas.height;
        for (var i = 0; i < pts.length; i++) {
          px[0] = 0; px[1] = 0; px[2] = 0; px[3] = 0;
          try {
            webgl2.readPixels(pts[i][0], pts[i][1], 1, 1, webgl2.RGBA, webgl2.UNSIGNED_BYTE, px);
            out += ' (' + pts[i][0] + ',' + pts[i][1] + ')=' + px[0] + ',' + px[1] + ',' + px[2] + ',' + px[3];
          } catch (e) {
            out += ' (' + pts[i][0] + ',' + pts[i][1] + ')=ERR';
          }
        }
        trace(out + ' clears=' + realClears + ' lastClear=' + lastClear);
        if (glFrame <= 3) {
          // Overwrite the whole default framebuffer with magenta using raw GL.
          // If the phone does NOT turn magenta, this canvas is not the one on
          // screen no matter what the GL calls report.
          try {
            inProbe = true;
            webgl2.clearColor(1, 0, 1, 1);
            webgl2.clear(webgl2.COLOR_BUFFER_BIT);
            inProbe = false;
            trace('raw clear magenta gl frame #' + glFrame);
          } catch (_) {}
        }
      } catch (e) {
        fail('samplePixels', e);
      }
    }

    var canvas = {
      getContext: getContext,
      getBoundingClientRect: function () {
        return { x: 0, y: 0, left: 0, top: 0, width: W, height: H, right: W, bottom: H };
      },
      addEventListener: listen,
      removeEventListener: unlisten,
      setAttribute: function () {},
      removeAttribute: function () {},
      hasAttribute: function () { return false; },
      focus: function () {},
      blur: function () {},
      requestPointerLock: function () {},
      scrollIntoView: function () {},
      setPointerCapture: function () {},
      releasePointerCapture: function () {},
      getRootNode: function () { return doc; },
      appendChild: function (c) { return c; },
      removeChild: function (c) { return c; },
      contains: function () { return false; },
      style: style,
      ownerDocument: null,
      tagName: 'CANVAS',
      nodeName: 'CANVAS',
      nodeType: 1,
      isConnected: true,
      id: String(canvasSelector).replace(/^#/, ''),
      className: '',
      clientWidth: W,
      clientHeight: H,
      offsetWidth: W,
      offsetHeight: H
    };
    Object.defineProperty(canvas, 'width', {
      get: function () { return realCanvas.width; },
      set: function (v) { realCanvas.width = v; }
    });
    Object.defineProperty(canvas, 'height', {
      get: function () { return realCanvas.height; },
      set: function (v) { realCanvas.height = v; }
    });

    // ── minimal DOM ──────────────────────────────────────────────────────────
    function makeStyle() {
      return {
        setProperty: function (k, v) { this[k] = v; },
        removeProperty: function (k) { delete this[k]; },
        getPropertyValue: function (k) { return this[k] == null ? '' : String(this[k]); }
      };
    }
    function makeElement(tag) {
      return {
        tagName: String(tag || 'div').toUpperCase(),
        nodeName: String(tag || 'div').toUpperCase(),
        nodeType: 1,
        isConnected: true,
        style: makeStyle(),
        children: [],
        appendChild: function (c) { this.children.push(c); return c; },
        removeChild: function (c) {
          var i = this.children.indexOf(c);
          if (i >= 0) this.children.splice(i, 1);
          return c;
        },
        insertBefore: function (c) { this.children.push(c); return c; },
        setAttribute: function () {},
        removeAttribute: function () {},
        hasAttribute: function () { return false; },
        addEventListener: function () {},
        removeEventListener: function () {},
        getBoundingClientRect: function () {
          return { x: 0, y: 0, left: 0, top: 0, width: W, height: H, right: W, bottom: H };
        },
        focus: function () {},
        blur: function () {},
        getContext: function () { return null; },
        contains: function () { return false; }
      };
    }

    var body = makeElement('body');
    var head = makeElement('head');
    var documentElement = makeElement('html');
    documentElement.clientWidth = W;
    documentElement.clientHeight = H;

    var docListeners = Object.create(null);
    function docListen(type, fn) {
      (docListeners[type] || (docListeners[type] = [])).push(fn);
    }
    function docUnlisten(type, fn) {
      var a = docListeners[type];
      if (!a) return;
      var i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    }
    function dispatchDoc(type, ev) {
      var a = docListeners[type];
      if (!a) return;
      for (var i = 0; i < a.length; i++) {
        try { a[i](ev); } catch (e) { fail('document ' + type + ' listener', e); }
      }
    }

    var doc = {
      currentScript: null,
      readyState: 'complete',
      visibilityState: 'visible',
      hidden: false,
      fullscreenElement: null,
      pointerLockElement: null,
      body: body,
      head: head,
      documentElement: documentElement,
      defaultView: null,
      fonts: { ready: Promise.resolve(), add: function () {}, check: function () { return true; } },
      createElement: function (tag) {
        return String(tag).toLowerCase() === 'canvas' ? canvas : makeElement(tag);
      },
      createElementNS: function (_ns, tag) {
        return String(tag).toLowerCase() === 'canvas' ? canvas : makeElement(tag);
      },
      createTextNode: function (text) { return { textContent: text, nodeType: 3 }; },
      createEvent: function () { return { initEvent: function () {} }; },
      querySelector: function () { return canvas; },
      querySelectorAll: function () { return []; },
      getElementById: function () { return canvas; },
      getElementsByTagName: function () { return []; },
      getElementsByClassName: function () { return []; },
      contains: function () { return true; },
      addEventListener: docListen,
      removeEventListener: docUnlisten,
      dispatchEvent: function (ev) { dispatchDoc(ev && ev.type, ev); return true; },
      exitPointerLock: function () {},
      exitFullscreen: function () {},
      hasFocus: function () { return true; },
      getSelection: function () { return null; }
    };
    canvas.ownerDocument = doc;

    // Persist through the mini-game storage API when it is available.  The
    // in-memory map stays as a cache and as a fallback for browser preview.
    var storage = {
      _data: Object.create(null),
      _persist: false,
      _load: function () {
        var self = this;
        try {
          if (typeof tt !== 'undefined' && typeof tt.getStorageInfoSync === 'function') {
            var info = tt.getStorageInfoSync() || {};
            (info.keys || []).forEach(function (k) {
              var v = tt.getStorageSync(k);
              if (v !== '' && v != null) self._data[k] = String(v);
            });
            self._persist = typeof tt.setStorageSync === 'function';
          }
        } catch (e) { self._persist = false; }
      },
      getItem: function (k) { return this._data[k] == null ? null : this._data[k]; },
      setItem: function (k, v) {
        this._data[k] = String(v);
        if (this._persist) { try { tt.setStorageSync(k, this._data[k]); } catch (e) {} }
      },
      removeItem: function (k) {
        delete this._data[k];
        if (this._persist) { try { tt.removeStorageSync(k); } catch (e) {} }
      },
      clear: function () {
        var keys = Object.keys(this._data);
        this._data = Object.create(null);
        if (this._persist) {
          keys.forEach(function (k) { try { tt.removeStorageSync(k); } catch (e) {} });
        }
      },
      key: function (i) { return Object.keys(this._data)[i] || null; },
      get length() { return Object.keys(this._data).length; }
    };
    storage._load();

    var nativePerf = G.performance || {};
    var perf = {
      now: typeof nativePerf.now === 'function'
        ? function () { return nativePerf.now(); }
        : function () { return Date.now(); },
      timeOrigin: nativePerf.timeOrigin || Date.now(),
      mark: function () {},
      measure: function () {},
      getEntriesByName: function () { return []; },
      getEntriesByType: function () { return []; },
      clearMarks: function () {},
      clearMeasures: function () {}
    };

    function fallbackSetTimeout(fn, ms) {
      return setTimeout(fn, ms);
    }
    function fallbackClearTimeout(id) {
      return clearTimeout(id);
    }
    // Capture the host functions before `put()` overwrites the globals.
    // Calling G.requestAnimationFrame dynamically after publish recursively
    // calls our own shim (RangeError: Maximum call stack size exceeded).
    var nativeRaf = typeof G.requestAnimationFrame === 'function'
      ? G.requestAnimationFrame.bind(G) : null;
    var nativeCaf = typeof G.cancelAnimationFrame === 'function'
      ? G.cancelAnimationFrame.bind(G) : null;
    var nativeFetch = typeof G.fetch === 'function' ? G.fetch.bind(G) : null;
    var nativeSetInterval = typeof G.setInterval === 'function' ? G.setInterval.bind(G) : null;
    var nativeSetTimeout = typeof G.setTimeout === 'function' ? G.setTimeout.bind(G) : null;
    // Frame instrumentation: a black screen with no logs is otherwise
    // indistinguishable between "no frame ran" and "frames run but draw
    // nothing".  Every callback is wrapped so that an exception inside the
    // engine's animation frame is reported instead of vanishing into
    // "[TMG] Error: at requestAnimationFrame callback JS Function calls failed".
    var frameCount = 0;
    var glFrames = 0;
    var lastSrc = null;
    var srcFrames = 0;
    var inProbe = false;
    var rawRaf = nativeRaf
      ? function (fn) { return nativeRaf(fn); }
      : function (fn) { return fallbackSetTimeout(function () { fn(perf.now()); }, 16); };
    function raf(fn) {
      return rawRaf(function (t) {
        frameCount++;
        if (PROBE && frameCount <= 40) {
          // Identify *whose* callback this is: the engine drives its own
          // animation frames before the game starts, so a heartbeat alone
          // cannot prove bevy's loop is alive.  Log every new source and then
          // how long each source keeps being used.
          var src = '';
          try { src = String(fn).replace(/\s+/g, ' ').slice(0, 60); } catch (_) {}
          if (src !== lastSrc) {
            if (lastSrc !== null) log('raf src end: ' + lastSrc.slice(0, 40) + ' after ' + srcFrames + ' f');
            lastSrc = src;
            srcFrames = 0;
            log('raf src #' + frameCount + ' fn=' + src);
          } else if (frameCount <= 400 && frameCount % 100 === 0) {
            log('raf src still: ' + src.slice(0, 40) + ' frames=' + srcFrames);
          }
          srcFrames++;
        }
        try {
          fn(t);
        } catch (e) {
          fail('raf callback #' + frameCount, e);
          throw e;
        }
        // Count frames *after* the WebGL context exists: the engine drives its
        // own rAF loop long before wgpu asks for a context, so a plain frame
        // counter would have blown past its sampling window by then.
        if (PROBE && webgl2) {
          glFrames++;
          if (glFrames <= 4 || glFrames % 300 === 0) {
            trace('raf #' + frameCount + ' gl frame #' + glFrames);
            samplePixels(glFrames);
          }
        }
      });
    }
    var caf = nativeCaf || fallbackClearTimeout;

    function matchMedia(query) {
      var q = String(query).toLowerCase();
      var dark = currentTheme !== 'light';
      var matches = false;
      if (q.indexOf('prefers-color-scheme: dark') >= 0) matches = dark;
      if (q.indexOf('prefers-color-scheme: light') >= 0) matches = !dark;
      return {
        matches: matches,
        media: String(query),
        onchange: null,
        addListener: function () {},
        removeListener: function () {},
        addEventListener: function () {},
        removeEventListener: function () {},
        dispatchEvent: function () { return false; }
      };
    }

    var winListeners = Object.create(null);
    function winListen(type, fn) {
      (winListeners[type] || (winListeners[type] = [])).push(fn);
    }
    function winUnlisten(type, fn) {
      var a = winListeners[type];
      if (!a) return;
      var i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    }
    function dispatchWin(type, ev) {
      var a = winListeners[type];
      if (!a) return;
      for (var i = 0; i < a.length; i++) {
        try { a[i](ev); } catch (e) { fail('window ' + type + ' listener', e); }
      }
    }

    var win = {
      document: doc,
      innerWidth: W,
      innerHeight: H,
      outerWidth: W,
      outerHeight: H,
      devicePixelRatio: devicePixelRatio,
      screen: { width: screenW, height: screenH, availWidth: screenW, availHeight: screenH, colorDepth: 24 },
      location: {
        href: cfg.location || 'https://bevy.local/',
        protocol: 'https:',
        host: cfg.host || 'bevy.local',
        hostname: cfg.host || 'bevy.local',
        search: '',
        hash: '',
        origin: 'https://bevy.local'
      },
      navigator: {
        userAgent: cfg.userAgent || 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 DouyinMiniGame',
        platform: sysInfo.platform || 'devtools',
        language: 'zh-CN',
        languages: ['zh-CN'],
        hardwareConcurrency: 4,
        maxTouchPoints: 5,
        getGamepads: function () { return []; },
        onLine: true,
        cookieEnabled: false
      },
      performance: perf,
      localStorage: storage,
      sessionStorage: storage,
      addEventListener: winListen,
      removeEventListener: winUnlisten,
      dispatchEvent: function (ev) { dispatchWin(ev && ev.type, ev); return true; },
      getComputedStyle: function () { return style; },
      matchMedia: matchMedia,
      setTimeout: function (fn, ms) {
        return typeof G.setTimeout === 'function' ? G.setTimeout(fn, ms) : fallbackSetTimeout(fn, ms);
      },
      clearTimeout: function (id) {
        return typeof G.clearTimeout === 'function' ? G.clearTimeout(id) : fallbackClearTimeout(id);
      },
      setInterval: function (fn, ms) {
        return typeof G.setInterval === 'function' ? G.setInterval(fn, ms) : setInterval(fn, ms);
      },
      clearInterval: function (id) {
        return typeof G.clearInterval === 'function' ? G.clearInterval(id) : clearInterval(id);
      },
      queueMicrotask: function (cb) { return Promise.resolve().then(cb); },
      requestAnimationFrame: function (fn) { return raf(fn); },
      cancelAnimationFrame: function (id) { return caf(id); },
      crypto: G.crypto
    };
    win.self = win;
    win.window = win;
    win.parent = win;
    win.top = win;
    publish('SafeArea', safeArea);
    // Rust reads the canvas size back through `window` (the shim above), not
    // through GameGlobal, so publish it on both.
    publish('Canvas', { width: W, height: H });
    publish('Theme', currentTheme);
    log('theme: ' + currentTheme);
    try {
      if (typeof tt.onThemeChange === 'function') {
        tt.onThemeChange(function (res) {
          manualTheme = null;
          setTheme(res && (res.theme || res.themeMode || res.colorScheme));
        });
      }
    } catch (e) {}
    publish('SetTheme', function (value) {
      var next = String(value || '').toLowerCase() === 'light' ? 'light' : 'dark';
      manualTheme = next;
      setTheme(next);
    });

    // ── rewarded video ads ────────────────────────────────────────────────
    // A single rewarded-video unit can serve all three reward placements.
    // `adUnitIds` is optional; use it later if each placement gets its own
    // traffic-owner ad slot. With no ad unit configured (or no
    // tt.createRewardedVideoAd in the host) the adapter runs a local mock so
    // the simulator exercises the same state machine as a real device. Set
    // `mockAds: false` to get `unavailable` instead.
    var rewardedAds = Object.create(null);
    var MOCK_AD_RESULTS = { ended: true, skipped: true, error: true };
    function adUnitFor(kind) {
      if (cfg.adUnitIds && cfg.adUnitIds[kind]) return String(cfg.adUnitIds[kind]);
      return cfg.adUnitId ? String(cfg.adUnitId) : '';
    }
    function publishAdStatus(status) {
      publish('AdStatus', status);
    }
    publishAdStatus('idle');
    publish('AdMock', false);

    function showMockAd(kind) {
      publish('AdMock', true);
      var result = String(cfg.mockAdResult || 'ended').toLowerCase();
      if (!MOCK_AD_RESULTS[result]) result = 'ended';
      var delay = Number(cfg.mockAdDelay);
      if (!(delay >= 0)) delay = 600;
      publishAdStatus('loading');
      log('ad mock kind=' + kind + ' result=' + result + ' delay=' + delay + 'ms');
      var finish = function () {
        publishAdStatus(result);
        log('ad mock finished: ' + result);
      };
      if (nativeSetTimeout) nativeSetTimeout(finish, delay);
      else finish();
      return true;
    }
    function getRewardedVideo(kind) {
      var unitId = adUnitFor(kind);
      if (!unitId || typeof tt === 'undefined' || typeof tt.createRewardedVideoAd !== 'function') {
        return null;
      }
      if (rewardedAds[unitId]) return rewardedAds[unitId];
      var ad;
      try {
        ad = tt.createRewardedVideoAd({ adUnitId: unitId });
      } catch (e) {
        log('ad create failed: ' + describeError(e));
        return null;
      }
      rewardedAds[unitId] = ad;
      ad.onClose(function (res) {
        var ended = !!(res && res.isEnded);
        publishAdStatus(ended ? 'ended' : 'skipped');
        log('ad close ended=' + ended);
      });
      ad.onError(function (err) {
        publishAdStatus('error');
        log('ad error: ' + describeError(err));
      });
      return ad;
    }
    publish('ShowAd', function (kind) {
      var unitId = adUnitFor(kind);
      var ad = getRewardedVideo(kind);
      if (!ad) {
        if (!unitId && cfg.mockAds !== false) return showMockAd(kind);
        publishAdStatus(unitId ? 'error' : 'unavailable');
        return false;
      }
      publish('AdMock', false);
      publishAdStatus('loading');
      log('ad show kind=' + kind);
      var shown;
      try {
        shown = ad.show();
      } catch (e) {
        shown = Promise.reject(e);
      }
      if (shown && typeof shown.then === 'function') {
        shown.catch(function (err) {
          log('ad show failed, retrying after load: ' + describeError(err));
          try {
            ad.load().then(function () {
              return ad.show();
            }).catch(function (e2) {
              publishAdStatus('error');
              log('ad load/show failed: ' + describeError(e2));
            });
          } catch (e2) {
            publishAdStatus('error');
            log('ad retry failed: ' + describeError(e2));
          }
        });
      }
      return true;
    });

    if (nativeSetInterval) {
      nativeSetInterval(function () {
        var next = systemTheme();
        if (!manualTheme && next && next !== currentTheme) setTheme(next);
      }, 4000);
    }

    // ── touch → pointer events ───────────────────────────────────────────────
    // winit listens on the canvas for pointerdown/pointermove/pointerup.  The
    // mini-game runtime only exposes tt.onTouch*, so synthesize the subset of
    // PointerEvent that winit reads.  Coordinates are mapped from logical
    // screen space to the canvas resolution.
    var touchLogged = false;
    function emitPointer(type, touch, buttons) {
      var x = touch.clientX != null ? touch.clientX : touch.pageX;
      var y = touch.clientY != null ? touch.clientY : touch.pageY;
      if (x == null) return;
      var ev = {
        pointerId: touch.identifier == null ? 1 : touch.identifier,
        pointerType: 'touch',
        isPrimary: true,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y,
        screenX: x,
        screenY: y,
        offsetX: x * (W / screenW),
        offsetY: y * (H / screenH),
        movementX: 0,
        movementY: 0,
        // PointerEvent semantics: `button` is -1 while no button changed, so
        // winit does not mistake a drag for a chorded mouse-button event (it
        // returns early on those and the resulting touch move is never read).
        button: type === 'pointermove' ? -1 : 0,
        buttons: buttons,
        pressure: buttons ? 0.5 : 0,
        width: 1,
        height: 1,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        target: canvas,
        currentTarget: canvas,
        preventDefault: function () {},
        stopPropagation: function () {}
      };
      if (!touchLogged) {
        touchLogged = true;
        trace('first touch: ' + type + ' at ' + Math.round(ev.offsetX) + ',' + Math.round(ev.offsetY));
      }
      if (PROBE) {
        // Drag-to-deploy is easy to break silently (a malformed synthetic
        // PointerEvent makes winit drop every move), so log the stream while
        // device probes are on.
        console.log('[touch] ' + type + ' ' + Math.round(ev.offsetX) + ',' + Math.round(ev.offsetY));
      }
      var list = listeners[type];
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        try { list[i](ev); } catch (e) { fail(type + ' listener', e); }
      }
    }
    function eachChanged(res, type, buttons) {
      var list = (res && res.changedTouches) || (res && res.touches) || [];
      for (var i = 0; i < list.length; i++) emitPointer(type, list[i], buttons);
    }
    if (cfg.touch !== false && typeof tt.onTouchStart === 'function') {
      tt.onTouchStart(function (res) { eachChanged(res, 'pointerdown', 1); });
      tt.onTouchMove(function (res) { eachChanged(res, 'pointermove', 1); });
      tt.onTouchEnd(function (res) { eachChanged(res, 'pointerup', 0); });
      if (typeof tt.onTouchCancel === 'function') {
        tt.onTouchCancel(function (res) { eachChanged(res, 'pointercancel', 0); });
      }
    }

    // ── lifecycle ────────────────────────────────────────────────────────────
    function dispatchCanvas(type, ev) {
      var a = listeners[type];
      if (!a) return;
      for (var i = 0; i < a.length; i++) {
        try { a[i](ev); } catch (e) { fail('canvas ' + type + ' listener', e); }
      }
    }
    function setVisible(visible) {
      doc.hidden = !visible;
      doc.visibilityState = visible ? 'visible' : 'hidden';
      dispatchDoc('visibilitychange', {
        type: 'visibilitychange', target: doc, currentTarget: doc
      });
      var type = visible ? 'focus' : 'blur';
      var ev = { type: type, target: canvas, currentTarget: canvas };
      dispatchCanvas(type, ev);
      dispatchWin(type, { type: type, target: win, currentTarget: win });
    }
    if (typeof tt.onShow === 'function') tt.onShow(function () { setVisible(true); });
    if (typeof tt.onHide === 'function') tt.onHide(function () { setVisible(false); });

    // ── observers ────────────────────────────────────────────────────────────
    function ResizeObserver(cb) { this._cb = cb; }
    ResizeObserver.prototype.observe = function (target) {
      var self = this;
      fallbackSetTimeout(function () {
        try {
          var rect = target && target.getBoundingClientRect
            ? target.getBoundingClientRect()
            : { x: 0, y: 0, left: 0, top: 0, width: W, height: H, right: W, bottom: H };
          // winit reads devicePixelContentBoxSize[0] when the browser
          // advertises support; without it the callback throws while Rust
          // tries to read index 0 of an undefined value.
          self._cb([{
            target: target,
            contentRect: rect,
            contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
            borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
            devicePixelContentBoxSize: [{
              inlineSize: Math.round(rect.width * devicePixelRatio),
              blockSize: Math.round(rect.height * devicePixelRatio)
            }]
          }], self);
        } catch (e) { fail('ResizeObserver callback', e); }
      }, 0);
    };
    ResizeObserver.prototype.unobserve = function () {};
    ResizeObserver.prototype.disconnect = function () {};

    function IntersectionObserver(cb) { this._cb = cb; }
    IntersectionObserver.prototype.observe = function (target) {
      var self = this;
      fallbackSetTimeout(function () {
        try {
          self._cb([{ isIntersecting: true, intersectionRatio: 1, target: target }], self);
        } catch (e) { fail('IntersectionObserver callback', e); }
      }, 30);
    };
    IntersectionObserver.prototype.unobserve = function () {};
    IntersectionObserver.prototype.disconnect = function () {};

    // winit probes ResizeObserverEntry.prototype for
    // `devicePixelContentBoxSize` to decide which ResizeObserver mode to use.
    function ResizeObserverEntry() {}
    try {
      Object.defineProperty(ResizeObserverEntry.prototype, 'devicePixelContentBoxSize', {
        configurable: true,
        get: function () { return this._devicePixelContentBoxSize; }
      });
    } catch (e) {}

    // ── constructor shims needed by wasm-bindgen dyn_into ────────────────────
    var RealWebGL2 = typeof G.WebGL2RenderingContext === 'function' ? G.WebGL2RenderingContext : null;
    var RealWebGL = typeof G.WebGLRenderingContext === 'function' ? G.WebGLRenderingContext : null;

    function makeClass(name, predicate) {
      var C = function () {};
      try { Object.defineProperty(C, 'name', { configurable: true, value: name }); } catch (e) {}
      if (typeof Symbol !== 'undefined' && Symbol.hasInstance) {
        try {
          Object.defineProperty(C, Symbol.hasInstance, {
            configurable: true,
            value: function (obj) {
              try { return !!predicate(obj); } catch (e) { return false; }
            }
          });
        } catch (e) {}
      }
      return C;
    }

    var Window = makeClass('Window', function (o) { return o === win || o === G; });
    var Element = makeClass('Element', function (o) { return !!(o && o.nodeType === 1); });
    var HTMLElement = makeClass('HTMLElement', function (o) { return !!(o && o.nodeType === 1); });
    var HTMLCanvasElement = makeClass('HTMLCanvasElement', function (o) { return o === canvas; });
    var CSSStyleDeclaration = makeClass('CSSStyleDeclaration', function (o) {
      return !!(o && typeof o.getPropertyValue === 'function');
    });
    var DOMRect = makeClass('DOMRect', function (o) {
      return !!(o && typeof o.width === 'number' && typeof o.height === 'number');
    });
    var WebGL2RenderingContext = makeClass('WebGL2RenderingContext', function (o) {
      return (o === webgl2 && glType === 'webgl2') || (RealWebGL2 !== null && o instanceof RealWebGL2);
    });
    var WebGLRenderingContext = makeClass('WebGLRenderingContext', function (o) {
      return (o === webgl2 && glType === 'webgl') || (RealWebGL !== null && o instanceof RealWebGL);
    });

    var DOMException = typeof G.DOMException === 'function'
      ? G.DOMException
      : function (msg, name) {
        var e = new Error(msg || 'DOMException');
        e.name = name || 'DOMException';
        return e;
      };

    // ── publish globals ──────────────────────────────────────────────────────
    var ROOTS = [];
    function addRoot(r) {
      try { if (r && ROOTS.indexOf(r) < 0) ROOTS.push(r); } catch (e) {}
    }
    addRoot(G);
    try { addRoot(globalThis); } catch (e) {}
    try { addRoot(self); } catch (e) {}
    try { addRoot(global); } catch (e) {}
    addRoot(win);

    function put(name, value) {
      for (var i = 0; i < ROOTS.length; i++) {
        try {
          Object.defineProperty(ROOTS[i], name, {
            configurable: true, writable: true, value: value
          });
        } catch (e) {
          try { ROOTS[i][name] = value; } catch (e2) {
            log('cannot set global ' + name + ' on root ' + i);
          }
        }
      }
    }

    put('window', win);
    put('self', win);
    put('document', doc);
    put('navigator', win.navigator);
    put('location', win.location);
    put('performance', perf);
    put('screen', win.screen);
    put('localStorage', storage);
    put('sessionStorage', storage);
    put('getComputedStyle', function () { return style; });
    put('matchMedia', matchMedia);
    put('requestAnimationFrame', function (fn) { return raf(fn); });
    put('cancelAnimationFrame', function (id) { return caf(id); });
    put('queueMicrotask', function (cb) { return Promise.resolve().then(cb); });
    put('fetch', function (p) {
      if (typeof p === 'string') return p;
      if (nativeFetch) return nativeFetch(p);
      return p;
    });

    put('Window', Window);
    put('EventTarget', makeClass('EventTarget', function (o) {
      return !!(o && typeof o.addEventListener === 'function');
    }));
    put('Element', Element);
    put('HTMLElement', HTMLElement);
    put('HTMLCanvasElement', HTMLCanvasElement);
    put('CSSStyleDeclaration', CSSStyleDeclaration);
    put('DOMRect', DOMRect);
    put('WebGL2RenderingContext', WebGL2RenderingContext);
    put('WebGLRenderingContext', WebGLRenderingContext);
    put('DOMException', DOMException);
    put('ResizeObserver', ResizeObserver);
    put('ResizeObserverEntry', ResizeObserverEntry);
    put('IntersectionObserver', IntersectionObserver);
    put('__tt_qm', function (cb) { return Promise.resolve().then(cb); });

    // ── TextEncoder / TextDecoder ────────────────────────────────────────────
    // The simulator runs on Chromium and has both, but the iOS (and some
    // Android) mini-game JS engines do not.  wasm-bindgen touches them at
    // module scope, so on a real device the glue dies before Bevy boots:
    //   [TMG] ReferenceError: Can't find variable: TextDecoder
    // Only UTF-8 is implemented: that is all the glue and Bevy ask for.
    function utf8Decode(bytes) {
      var units = [];
      var out = '';
      var i = 0;
      var n = bytes.length;
      while (i < n) {
        var b = bytes[i++];
        var cp;
        if (b < 0x80) {
          cp = b;
        } else if (b < 0xc2) {
          cp = 0xfffd;                                        // stray continuation / overlong
        } else if (b < 0xe0) {
          if (i < n && (bytes[i] & 0xc0) === 0x80) {
            cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
          } else cp = 0xfffd;
        } else if (b < 0xf0) {
          if (i + 1 < n && (bytes[i] & 0xc0) === 0x80 && (bytes[i + 1] & 0xc0) === 0x80) {
            cp = ((b & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f);
            i += 2;
            if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
          } else cp = 0xfffd;
        } else if (b < 0xf5) {
          if (i + 2 < n &&
              (bytes[i] & 0xc0) === 0x80 &&
              (bytes[i + 1] & 0xc0) === 0x80 &&
              (bytes[i + 2] & 0xc0) === 0x80) {
            cp = ((b & 0x07) << 18) | ((bytes[i] & 0x3f) << 12) |
                 ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
            i += 3;
            if (cp < 0x10000 || cp > 0x10ffff) cp = 0xfffd;
          } else cp = 0xfffd;
        } else {
          cp = 0xfffd;
        }
        if (cp > 0xffff) {
          cp -= 0x10000;
          units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else {
          units.push(cp);
        }
        // Flush in blocks: apply() has an argument-count limit on old engines.
        if (units.length >= 8192) { out += String.fromCharCode.apply(null, units); units.length = 0; }
      }
      if (units.length) out += String.fromCharCode.apply(null, units);
      return out;
    }

    function toBytes(input) {
      if (input == null) return null;
      if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
      if (input.buffer && typeof input.byteOffset === 'number') {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      }
      return new Uint8Array(input);
    }

    function TextDecoderPolyfill(label, options) {
      var opts = options || {};
      this.encoding = 'utf-8';
      this.fatal = !!opts.fatal;
      this.ignoreBOM = !!opts.ignoreBOM;
    }
    TextDecoderPolyfill.prototype.decode = function (input) {
      var bytes = toBytes(input);
      if (!bytes || bytes.length === 0) return '';
      var start = 0;
      if (!this.ignoreBOM && bytes.length >= 3 &&
          bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        start = 3;
      }
      var sliced = start ? bytes.subarray(start) : bytes;
      return utf8Decode(sliced.length !== undefined ? sliced : bytes);
    };

    function TextEncoderPolyfill() {
      this.encoding = 'utf-8';
    }
    TextEncoderPolyfill.prototype.encodeInto = function (source, dest) {
      var s = String(source == null ? '' : source);
      var limit = dest.length;
      var written = 0;
      var read = 0;
      while (read < s.length) {
        var cp = s.charCodeAt(read);
        var next = read + 1;
        var size;
        if (cp >= 0xd800 && cp <= 0xdbff && read + 1 < s.length) {
          var lo = s.charCodeAt(read + 1);
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
            next = read + 2;
          } else cp = 0xfffd;
        } else if (cp >= 0xd800 && cp <= 0xdfff) {
          cp = 0xfffd;
        }
        size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
        if (written + size > limit) break;
        if (size === 1) {
          dest[written++] = cp;
        } else if (size === 2) {
          dest[written++] = 0xc0 | (cp >> 6);
          dest[written++] = 0x80 | (cp & 0x3f);
        } else if (size === 3) {
          dest[written++] = 0xe0 | (cp >> 12);
          dest[written++] = 0x80 | ((cp >> 6) & 0x3f);
          dest[written++] = 0x80 | (cp & 0x3f);
        } else {
          dest[written++] = 0xf0 | (cp >> 18);
          dest[written++] = 0x80 | ((cp >> 12) & 0x3f);
          dest[written++] = 0x80 | ((cp >> 6) & 0x3f);
          dest[written++] = 0x80 | (cp & 0x3f);
        }
        read = next;
      }
      return { read: read, written: written };
    };
    TextEncoderPolyfill.prototype.encode = function (source) {
      var s = String(source == null ? '' : source);
      var buf = new Uint8Array(s.length * 3 + 3);
      var used = this.encodeInto(s, buf).written;
      return buf.subarray(0, used);
    };

    if (typeof G.TextDecoder !== 'function') {
      put('TextDecoder', TextDecoderPolyfill);
      log('polyfilled TextDecoder');
    }
    if (typeof G.TextEncoder !== 'function') {
      put('TextEncoder', TextEncoderPolyfill);
      log('polyfilled TextEncoder');
    }

    // wasm-bindgen's init checks `module instanceof Response` before calling
    // WebAssembly; provide constructors if the host does not expose them.
    if (typeof G.Response !== 'function') {
      put('Response', function (body, init) {
        this._body = body;
        this.ok = true;
        this.status = 200;
        this.statusText = 'OK';
        this.headers = { get: function () { return 'application/wasm'; } };
        this.type = (init && init.type) || 'basic';
        this.url = '';
      });
      G.Response.prototype.arrayBuffer = function () {
        return Promise.resolve(this._body);
      };
    }
    if (typeof G.Request !== 'function') {
      put('Request', function (url) { this.url = url; });
    }

    // ── wasm API tracing ─────────────────────────────────────────────────────
    // On device the page can be torn down *while* the module is being fetched,
    // decompressed or compiled, taking `console` with it.  Wrap the WebAssembly
    // entry points so each step is persisted and the next launch can tell us
    // exactly which one never returned.  Douyin exposes TTWebAssembly, which
    // accepts a .br path and decompresses it natively.
    function traceWasmApi(obj, label) {
      if (!obj) return;
      var fns = ['instantiate', 'compile', 'compileStreaming', 'instantiateStreaming'];
      for (var i = 0; i < fns.length; i++) {
        (function (name) {
          var real;
          try { real = obj[name]; } catch (e) { return; }
          if (typeof real !== 'function') return;
          var wrapped = function (src) {
            var what = typeof src === 'string' ? src : Object.prototype.toString.call(src);
            log(label + '.' + name + ' <- ' + what);
            var out;
            try {
              out = real.apply(this, arguments);
            } catch (e) {
              fail(label + '.' + name + ' threw', e);
              throw e;
            }
            if (out && typeof out.then === 'function') {
              return out.then(function (v) {
                log(label + '.' + name + ' ok');
                return v;
              }, function (e) {
                fail(label + '.' + name + ' rejected', e);
                throw e;
              });
            }
            log(label + '.' + name + ' ok (sync)');
            return out;
          };
          try { obj[name] = wrapped; } catch (e) { log('cannot trace ' + label + '.' + name); }
        })(fns[i]);
      }
    }
    if (PROBE) {
      traceWasmApi(typeof WebAssembly !== 'undefined' ? WebAssembly : null, 'WebAssembly');
      traceWasmApi(typeof TTWebAssembly !== 'undefined' ? TTWebAssembly : null, 'TTWA');
    }

    doc.defaultView = win;

    var env = {
      version: VERSION,
      config: cfg,
      global: G,
      globalPrefix: globalPrefix,
      canvas: canvas,
      realCanvas: realCanvas,
      document: doc,
      window: win,
      style: style,
      logs: logs,
      log: log,
      fail: fail,
      setVisible: setVisible,
      webgl2: function () { return webgl2; }
    };
    installed = env;
    try { G.__bevyDouyinEnv = env; } catch (e) {}

    log('runtime installed: canvas=' + W + 'x' + H +
      ' screen=' + screenW + 'x' + screenH +
      ' TTWebAssembly=' + (typeof TTWebAssembly !== 'undefined') +
      ' probe=' + (PROBE ? 'on' : 'off'));
    return env;
  }

  var api = {
    version: VERSION,
    install: install
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    G.BevyDouyin = api;
  }
})();
