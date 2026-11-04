# 常见报错

> 说明：本文源自 `starter-v1` 的排障记录，原理仍然适用；路径已按当前结构
> （游戏仓库 + `addons/bevy-douyin`）调整。宿主接口见
> [host-contract.md](host-contract.md)。

先看抖音开发者工具的 console。Bevy/winit 的 panic 会以 `panicked at ...` 出现；wasm 的 `unreachable` 栈通常只有函数号，需要结合前后日志判断。

## `error[B0001]`：system 参数访问冲突

典型文本：

```
panicked at bevy_ecs-0.20.1/src/query/state.rs:216:13:
error[B0001]: <Enable the debug feature to see the name> in system ...
accesses component(s) ... in a way that conflicts with a previous system parameter ...
RuntimeError: unreachable
```

**原因**：同一个 system 里两个 `Query` 对同一个组件做了不兼容的访问，而它们的
archetype 没有互斥。例如：

```rust
// trail 要 &mut Transform，paddle 要 &Transform，两个 Without<Ball> 并不互斥
mut trail: Query<(&Trail, &mut Transform), Without<Ball>>,
paddles: Query<(&Paddle, &Transform), Without<Ball>>,
```

**修复**：给每一侧补上对方的 `Without`：

```rust
mut trail: Query<(&Trail, &mut Transform), (Without<Ball>, Without<Paddle>)>,
paddles: Query<(&Paddle, &Transform), (Without<Ball>, Without<Trail>)>,
```

只加 `Without<Ball>` 不够；两个 filter 必须能证明不会命中同一个实体。

## `eval is not a function` / `GameGlobal is not defined`

抖音 wasm 宿主里：

- `js_sys::eval` 不可用（真机和模拟器都会报 `JsValue(TypeError: eval is not a function)`）；
- wasm 侧的 `js_sys::global()` 不是 JS 侧的 `GameGlobal`，读不到 `GameGlobal.xxx`。

**修复**：adapter 会把 shim `window` 安装到 wasm 可见的 globalThis 上，Rust 侧用：

```rust
fn js_window() -> JsValue {
    js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("window"))
        .unwrap_or(JsValue::UNDEFINED)
}
```

再 `Reflect::get(window, "__bevy_douyin_Canvas")`。不要在 Rust 里 `eval`，也不要在
Rust 里直接引用 `GameGlobal`。启动初始化失败经常表现为所有全局都读不到、画布退回
默认 1280×720，检查 Host 的读取方式。

## `unknown import kind 0x7f @+...`

**原因**：`wasm-opt --all-features` 生成了 compact imports，抖音 wasm 引擎不认。

**修复**：用 `tools/build.sh` 里的显式特性列表，不要加 `--all-features`：

```bash
--enable-bulk-memory
--enable-mutable-globals
--enable-sign-ext
--enable-nontrapping-float-to-int
--enable-reference-types
--enable-multivalue
```

## `only callable from inside the `Window``

**原因**：wasm-bindgen glue 里的 `js_sys::global()` 和抖音的 `GameGlobal` 不是同一个对象，winit 的 `MainThreadMarker` 判定失败。

**修复**：确认 `tools/patch_glue.py` 已执行，且 glue 是 wasm-bindgen **0.2.129** 生成的。升级 wasm-bindgen 后要重新适配补丁。

## `Maximum call stack size exceeded`

**原因**：adapter 覆盖 `requestAnimationFrame` 后，自己的 `raf` 仍然通过全局名调用，形成递归。

**修复**：在覆盖全局之前保存并 bind 原生函数（当前 `runtime/adapter.js` 已处理）。如果你改过 RAF 部分，检查是否又引用了 `window.requestAnimationFrame`。

## `Cannot read properties of undefined (reading '0')`

**原因**：winit 的 `ResizeObserver` 回调读取 `entry.contentBoxSize[0]` / `borderBoxSize[0]`，而抖音回调没有这些字段。

**修复**：adapter 会给每条 entry 补 `contentBoxSize`、`borderBoxSize`、`devicePixelContentBoxSize` 数组。检查是否误删了 `ResizeObserver` 包装。

## `RefCell already borrowed` / 启动到一半停住

**原因**：shim 在 winit 回调里又触发了同一个事件循环，或某个全局函数被重复包装。

**修复**：

1. 确认 `adapter.install()` 只调用一次；
2. 确认没有在 `game.js` 里重复 `require` bootstrap / 手动改 `requestAnimationFrame`；
3. 看报错前最后一条 `[bevy-douyin]` 日志，定位到具体阶段（DOM、WebGL、RAF、glue）。

## 黑屏 / 只有背景色

按顺序检查：

1. console 是否有 `WebGL context created` 和 `AdapterInfo`；
2. 游戏 crate `main.rs` 的 `canvas` selector 是否和
   `platforms/douyin/package/game.js` 的 `canvas` 一致；
3. 是否在 `Startup` 里生成了相机和至少一个 `Sprite`；
4. 相机 `ScalingMode::Fixed` 的宽高是否和 `game.js` 的 `width/height` 一致；
5. 资源是否真的打进了输出包（主包 4 MB 限制）。

开发者工具的截图只能证明 UI 在，不能证明 GPU 画面在；以 console 的 `AdapterInfo` + 实际像素为准。

## `wasm-bindgen` 版本不匹配

症状可能是 glue 报错、`__wbindgen_start` 未定义，或补丁模式匹配失败。

```bash
wasm-bindgen --version          # 应为 0.2.129
grep -A1 'name = "wasm-bindgen"' Cargo.lock
```

不一致时：

```bash
cargo install wasm-bindgen-cli --version 0.2.129 --force
```

## 没有声音 / `No audio device found`

先看控制台有没有这一行：

```text
[bevy-douyin:my_game] audio: context ready sampleRate=44100 state=running
```

- **没有这行**：适配层版本低于 0.4，或 `tt.getAudioContext` 不可用（基础库
  低于 1.34.0）。先升级适配层；模拟器会回退到原生 `AudioContext`。
- **有这行但还是 `No audio device found`**：cpal 没拿到上下文。检查是否在
  `adapter.install()` 之前就初始化了 Bevy，或页面里另一个库覆盖了
  `AudioContext`。
- **`state=suspended`**：iOS 要求用户手势后才能出声。让玩家点一下屏幕；
  适配层会在第一次 `touchstart` 时 `resume()`。仍不行时检查系统静音键和音量。
- **有声音对象但听不到**：确认 Cargo 开了对应的解码 feature（`wav` /
  `vorbis` / `mp3`），WAV 必须是常见 PCM 头；`include_bytes!` 的路径要从
  源文件算起。
- **切后台回来没声音**：`onHide` 会 `suspend()`，`onShow` 会 `resume()`；
  如果宿主没有触发 `onShow`，点一下屏幕也能恢复。
- **真机与模拟器不同**：模拟器走 macOS 音频设备，真机走抖音的 WebAudio。
  真机上还要确认没有占用音频焦点、没有静音。

## 包体积超过 4 MB

- 确认用的是 `--release`；
- 确认 `Cargo.toml` 的 release profile 仍是 `opt-level = "z"`、`lto = true`、`panic = "abort"`、`strip = true`；
- 把 wasm 放分包，或改成远程加载；
- 不要把 `target/`、示例截图、未使用资源打进输出包。

## 模拟器能跑，真机黑屏 / 闪退

真机（iOS 26+，抖音 4.36.0，iPhone 16 实测）有三个独立的坑，模板已经全部规避；如果你在此基础上改坏了，按下面的顺序回退。

### 1. 启动一瞬间就被抖音踢回去，vConsole 里什么都没有

典型现象：

```
[TMG] Error: [trap] unreachable executed
    at __wasm_bindgen_func_elem_…
```

没有 panic、没有日志、页面直接回收，所以看起来像"闪退"。

**能确定的**：链接期把线性内存预留够之后，这个现象消失：

```bash
INITIAL_MEMORY_BYTES=${INITIAL_MEMORY_BYTES:-67108864}
export RUSTFLAGS="${RUSTFLAGS} -C link-arg=--initial-memory=$INITIAL_MEMORY_BYTES"
```

64 MiB 是 2D 游戏的稳妥默认值；更大的堆就调大这个变量，主包体积不受影响（内存不是文件大小）。

**不能确定、请勿照抄的旧结论**：曾经把原因写成"`memory.grow` 一次多页就 trap"，但实测（iPhone 16 / iOS 27.2 / 抖音 4.36.0）`grow(1)`、`grow(8)`、`grow(1024)` 和 256 MiB 分配全部成功，所以这个解释不成立。真正原因尚未定位，预留内存只是把这条路径从启动流程里移走了。

### 2. 能进游戏但只有一帧，之后黑屏

原因：WebGL2 后端无法创建多重采样管线，默认 4x MSAA 会让**所有**管线创建失败。

```
RenderError Validation: RenderPipeline with 'transparent_mesh2d_pipeline' label is invalid
```

而 bevy 默认的 `RenderErrorHandler` 遇到第一个错误就 `StopRendering` + 请求退出，表现为"渲染了一帧然后不动"。

修复（两处都要）：

```rust
// Msaa 在这个版本是 Component，且 Camera2d 已经 require 了它：
// 再往 bundle 里塞一个会 panic "has duplicate components"
commands.entity(camera).insert(Msaa::Off);

app.insert_resource(RenderErrorHandler(|error, _main, _render| {
    error!("RenderError {:?}: {}", error.ty, error.description);
    RenderErrorPolicy::Ignore   // 先把错误打出来，别急着停
}));
```

另外两处真机必改：

```rust
app.insert_resource(WinitSettings::continuous()); // 真机收不到 focus 事件，否则几帧后停摆
window.composite_alpha_mode = CompositeAlphaMode::Opaque; // 否则 alpha=0 的帧被合成掉
```

### 3. `GLSL compile FAILED: 'smooth' : syntax error`

naga 给 GLSL 输出带 `smooth` 插值限定符，iOS 的 WebGL 转译层不认识它：

```
GLSL compile FAILED: ERROR: 0:53: 'smooth' : syntax error: syntax error
```

`runtime/adapter.js` 在 `compileShader` 里剥掉它再编一次（`smooth` 本就是默认插值）：

```js
var fixed = src.replace(/\bsmooth\b(?!step)\s+/g, '');
gl.shaderSource(sh, fixed);
compile.call(gl, sh);
```

同时 `instrumentGL()` 会读 `getShaderInfoLog`/`getProgramInfoLog`：GL 后端是**懒编译**的，创建期的 shader 错误不会上报，只有 `set_pipeline` 时抛一句无用的 `label is invalid`，不 hook 就拿不到真错。

### 4. 玩着玩着闪退

先排除经典误区：**`memory.grow` 在 iOS 上是可用的**。实测（iPhone 16 / iOS 27.2 / 抖音 4.36.0）`grow(1)`、`grow(8)`、`grow(1024)` 全部成功，`new WebAssembly.Memory({ initial: 4096 })`（256 MiB）也能分配。

所以运行中崩更像是 panic（`panic = "abort"` 只留下一个 `unreachable`）或栈溢出。排查顺序：

1. 在 `game.js` 里、`runtime.start()` 之前设置 `GameGlobal.__probe = 1`
   （或传 `probe: true`）打开探针，下一次启动的弹窗会回放 panic 文本；
2. `__memProbe` 看内存曲线，确认不是线性泄漏；
3. 写自定义分配器时注意：wasm-ld 把 shadow stack 放在初始内存顶部（Rust 默认 1 MiB），任何 claim 到 `memory_size() * 64 KiB` 的做法都会吃掉栈，表现为启动即 `unreachable`。

### 5. 取证：真机上日志去哪了

wasm 内部经由 `console.log` 打的日志会被 `[TMG]` 吞掉，页面被杀时更是全丢。模板内置了可开关的探针：

```js
// platforms/douyin/package/game.js —— 必须在 require bootstrap 之前
if (typeof GameGlobal !== 'undefined') GameGlobal.__probe = 1;
var runtime = require('./runtime/bootstrap.js');
```

打开后：

- Rust 侧每秒/每帧输出 `diag: update #n t=… cams=… sprites=… clear=(…) win=…x… mem=…`，`mem` 恒定说明没有 grow；
- `GameGlobal.__memProbe = 1` 会在启动时按多种粒度试 `memory.grow`，最后一行就是它能承受的上限（需要游戏 crate 里的 probe 模块支持）；
- 崩溃前的日志写进 `GameGlobal.__bevy_stage` / 日志环，下次启动用 `tt.showModal` 回放（真机上比 console 可靠）；
- **不要用 `js_sys::eval` 调 `tt.showModal`**：抖音里 `eval` 不可用。需要弹窗时从
  `js_sys::global()` 取 `tt`，或用 `#[wasm_bindgen]` 导出/回调。

排查完记得把 `GameGlobal.__probe` 去掉：探针本身会拖慢帧率。

## 用 CLI 抓日志（可选）

如果安装了 `douyinide`，可以在项目打开后抓 console：

```bash
douyinide -c OpenCode get-project-windows-info
douyinide -c OpenCode miniapp-get-console-messages --window-id <id>
douyinide -c OpenCode miniapp-image-screenshot --window-id <id> --file-name shot
```

窗口 id 以 `get-project-windows-info` 返回的 `codeWindows[].id` 为准。
