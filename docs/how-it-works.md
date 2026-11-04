# 原理与实现

> 说明：本文源自 `starter-v1` 的设备调试记录，原理和真机坑仍然适用；目录示例
> 已按当前的「适配层 + 游戏仓库」结构改写。`probe` 模块属于游戏自己的 crate，
> 不在适配层内。宿主接口的权威定义见 [host-contract.md](host-contract.md)。

这套 runtime 不是 Bevy 官方插件，而是一层已经跑通的 **bootstrap shim**：让 Bevy 的 winit + wgpu 以为自己在浏览器里，实际底层是抖音小游戏的 `tt` API。

## 启动链路

```
platforms/douyin/package/game.js
  └─ runtime/bootstrap.js : start({ glue, wasm, canvas, width, height })
       ├─ runtime/adapter.js : install()  安装 window/document/canvas/WebGL2/RAF/输入
       ├─ require('./<name>.js')          加载 wasm-bindgen no-modules glue
       └─ glue({ module_or_path: '<name>.wasm.br' })
            └─ TTWebAssembly.instantiate(path, imports)
                 └─ __wbindgen_start() → Rust main() → Bevy App
```

顺序很重要：**必须先安装 shim，再 require glue**。所以 `game.js` 里 `glue` 是函数，而不是提前 `require` 好的对象。

## 三层兼容问题

Bevy web 端不是直接调用 WebGL，中间有两层浏览器假设：

1. **winit** 需要 `window`、`document`、`HTMLCanvasElement`、`ResizeObserver`、`IntersectionObserver`、`requestAnimationFrame`、`matchMedia`、`getComputedStyle`；
2. **wgpu-hal** 通过 winit 的 `WebCanvas` 拿 `canvas.getContext("webgl2")`，再 `dyn_into::<WebGl2RenderingContext>()`；
3. **wasm-bindgen glue** 自己还会访问 `GameGlobal`、`queueMicrotask`、`WebAssembly.instantiate`。

### 1. DOM 形状

`adapter.js` 用普通对象 + `Symbol.hasInstance` 伪造构造器：

- `tt.createCanvas()` 是唯一画布；
- `document.querySelector` / `getElementById` / `createElement('canvas')` 都返回它；
- `document.body` / `documentElement` / `contains` / `appendChild` / `addEventListener`；
- `canvas.style`、`getComputedStyle`、`getBoundingClientRect`、`setAttribute`、`focus`；
- `window.innerWidth/innerHeight`、`devicePixelRatio`、`location`、`navigator`、`performance`、`localStorage`。

wasm-bindgen 的 `dyn_into` 会做 `instanceof`，所以这些全局构造器必须存在：

`Window`、`EventTarget`、`Element`、`HTMLElement`、`HTMLCanvasElement`、`CSSStyleDeclaration`、`DOMRect`、`WebGL2RenderingContext`。

最重要的是 `HTMLCanvasElement` 和 `WebGL2RenderingContext`：wgpu surface 创建依赖它们。

### 2. WebGL2

- 首次 `getContext('webgl2', attrs)` 调用真实的 `tt` canvas；
- 后续请求复用同一个 context；
- context 对象会被 `WebGL2RenderingContext` 的 `hasInstance` 接受；
- 使用 `alpha: false, antialias: false, depth: true, stencil: true, premultipliedAlpha: true, preserveDrawingBuffer: false`。

wgpu 30 的 `webgl2` backend 会走 glow + WebGL2，不需要 WebGPU。

### 3. 事件循环与输入

- `requestAnimationFrame` 包装宿主 RAF。**必须在覆盖全局之前 bind 原生函数**，否则 adapter 自己的 `raf` 会再次调用被覆盖的 `requestAnimationFrame`，导致 `Maximum call stack size exceeded`；
- `ResizeObserver` 回调补 `contentBoxSize` / `borderBoxSize` / `devicePixelContentBoxSize`，否则 winit 读 `[0]` 会抛 `Cannot read properties of undefined`；
- 触摸事件映射成 `pointerdown/pointermove/pointerup`（winit 只读 pointer）；
- `visibilitychange`、`focus`、`blur`；
- `queueMicrotask` 用 `__tt_qm`（Promise 微任务）替代，抖音 wasm host 里裸调用会非法。

### 4. wasm-bindgen glue 补丁

`tools/patch_glue.py` 针对 **wasm-bindgen 0.2.129** 做三处字符串替换：

1. **`js_sys::global()` 不是 `GameGlobal`**

   抖音 wasm host 的 global 与 JS 侧 `GameGlobal` 不是同一个对象。glue 里 `GLOBAL` / `GLOBAL_THIS` / `SELF` / `WINDOW` 四个 accessor 改成 `GameGlobal.window`，否则 winit 的 `MainThreadMarker` 判断失败：

   ```
   panicked at ...: only callable from inside the `Window`
   ```

2. **`queueMicrotask`**

   改成 `__tt_qm`。

3. **`WebAssembly.instantiate`**

   抖音只接受包内相对路径，且 `.br` 由 `TTWebAssembly` 自己解压：

   ```js
   TTWebAssembly.instantiate("bevy_game.wasm.br", imports)
   ```

补丁是字符串匹配。升级 wasm-bindgen 后，如果模式不匹配，`patch_glue.py` 会直接失败，不会静默产出坏包——这是故意的。

## 构建

`tools/build.sh` 的流程：

```text
cargo build --release --target wasm32-unknown-unknown
  → wasm-bindgen --target no-modules --no-typescript
  → wasm-opt -Oz --converge（显式特性，见下）
  → brotli -q 11 -w 22
  → 复制 runtime/adapter.js + bootstrap.js
  → patch_glue.py
  → esbuild 压缩 glue + adapter（可选）
```

体积优化、Cargo feature 取舍和失败过的方案见 [wasm-size.md](wasm-size.md)。

### 为什么不能 `wasm-opt --all-features`

binaryen 133 会生成 compact imports：

```
unknown import kind 0x7f @+13820
```

抖音 wasm 引擎不接受。脚本只启用：

```
--enable-bulk-memory
--enable-mutable-globals
--enable-sign-ext
--enable-nontrapping-float-to-int
--enable-reference-types
--enable-multivalue
```

### 资源

Bevy 默认从 `assets/` 加载资源。`build.sh` 会把 `--assets` 指定的目录复制到输出包
（默认 `douyin/assets/`），adapter 的 `fetch` 对字符串直接返回包内路径，所以
`AssetServer::load("sprite.png")` 在模拟器里可用。资源同样受主包 4 MB 限制。

### 体积

Pong 参考构建（旧版数据；当前构建脚本会再压缩 JS）：

| 文件 | 大小 |
| --- | --- |
| `pong.wasm.br` | ~3.2 MB |
| `pong.js` | ~119 KB |
| `runtime/adapter.js` | ~25 KB |
| `runtime/bootstrap.js` | ~2 KB |

抖音主包限制约 4 MB，当前单包能放下。更复杂的游戏应把 wasm 放分包，或远程加载。**`.wasm.br` 后缀要保留**，`TTWebAssembly.instantiate` 依赖它判断是否解压。

## API

### `adapter.install(options) -> env`

只安装一次；重复调用返回同一个 `env`。

| option | 默认 | 说明 |
| --- | --- | --- |
| `width` / `height` | `1280` / `720` | 逻辑分辨率，同时也是 canvas CSS 尺寸 |
| `canvas` | `#bevy-canvas` | winit 查找的 selector |
| `devicePixelRatio` | `1` | 显式覆盖 DPR；默认固定，不随窗口变化 |
| `screenWidth` / `screenHeight` | `tt.getSystemInfoSync()` | 屏幕尺寸 |
| `touch` | `true` | 是否把 `tt.onTouch*` 映射成 pointer/touch 事件 |
| `adUnitId` | 无 | 激励视频广告位；为空时走本地 mock |
| `mockAds` | `true` | 无广告位时是否启用 mock；`false` 则返回 `unavailable` |
| `mockAdResult` | `'ended'` | mock 结果：`ended` / `skipped` / `error` |
| `mockAdDelay` | `600` | mock 的 loading 时长（ms） |
| `name` | 无 | 日志前缀 `[bevy-douyin:<name>]` |
| `log` | `console.log` | 自定义日志函数 |
| `userAgent` / `location` / `host` | 内置抖音 UA/URL | 个别库会读取 |

返回的 `env` 包含 `log`、`fail`、`global`、`version`，以及内部对象（调试用）。

### `bootstrap.start(options)`

```js
runtime.start({
  ...adapterOptions,
  wasm: 'bevy_game.wasm.br',
  glue: function () { return require('./bevy_game.js'); },
  onReady: function (env) {},
  onError: function (e) {}
});
```

返回 wasm-bindgen 的 init Promise，同时挂到 `GameGlobal.__bevyBoot`；启动错误挂到 `__bevyBootError`。

## 真机链路

模拟器用的是桌面 ANGLE，真机是 iOS 的 WebGL 转译层，两者差在四处，模板都已处理：

| 现象 | 原因 | 处理位置 |
| --- | --- | --- |
| 启动瞬间被踢回抖音，无日志 | iOS JSC 在 `memory.grow` 多页时 `[trap] unreachable executed` | `tools/build.sh` 的 `--initial-memory` |
| 只渲染一帧就黑 | WebGL2 建不出 MSAA 管线，默认 handler 直接 `StopRendering` | `Msaa::Off` + `RenderErrorHandler` |
| `GLSL compile FAILED: 'smooth'` | naga 输出的 `smooth` 限定符被 iOS 拒绝 | `adapter.js` 的 `instrumentGL()` |
| 几帧后停摆 / 画面被合成掉 | 收不到 focus 事件；surface alpha 非不透明 | `WinitSettings::continuous()` + `CompositeAlphaMode::Opaque` |
| 内存不够用 | 初始内存固定 64 MiB（`memory.grow` 本身在 iOS 上可用，但启动阶段不增长更好预测） | 调大 `INITIAL_MEMORY_BYTES` |

另外，游戏 crate 里可以放一个 `probe` 模块（starter 的 `src/probe.rs` 是现成示例），
用 `GameGlobal.__probe` 开关输出取证日志（`diag: update #…`、`memory.grow` 探测、
崩溃回放弹窗）。适配层也支持 `probe: true`，会把渲染/帧相关日志打得更细。
排查时在 `game.js` 里、`runtime.start()` 之前设置：

```js
if (typeof GameGlobal !== 'undefined') GameGlobal.__probe = 1;
```

## 已验证

> 以下结果来自 starter-v1 时期（同一套 runtime）。适配层拆分后，示例仓库
> `bevy_douyin_example` 在 macOS 抖音开发者工具中重新验证了启动、渲染、触摸
> 和 mock 激励视频；真机结果尚未在新结构下重新跑过。

模拟器（macOS，抖音开发者工具）：

- Bevy 0.20 + wgpu 30 + winit 0.30.13 启动；
- `AdapterInfo` 为 ANGLE Metal / Apple M1，`backend: "Gl"`；
- 2D Pong 持续渲染；
- `miniapp-swipe` 触摸能移动球拍；
- 控制台无 panic。

真机（iPhone 16 / iOS 27.2 / 抖音 4.36.0）：

- 启动、渲染、触摸输入、连续多帧（`diag` 探针 30 帧以上）；
- `GLSL compile FAILED: 'smooth'` 与 MSAA 错误均在规避后消失。

![Pong 截图](pong-screenshot.png)

## 已知限制

- **真机只验证了 iOS**（iPhone 16 / iOS 27.2 / 抖音 4.36.0）。低端 Android 的 WebGL2 / ANGLE 差异未测。
- **只支持 WebGL2**。没有 WebGL1 fallback；不支持 WebGPU。
- **Downlevel 限制**：模拟器报告 `max_storage_buffers_per_shader_stage = 0`，Bevy 会关闭 GPU preprocessing、OIT、部分后处理。重度 3D 项目需要重新评估。
- **无音频验证**。Bevy audio 需要额外 shim（`AudioContext` 等），当前未接。
- **无多线程**。抖音小游戏 wasm 不支持 threads；Bevy 任务池会走单线程路径。
- **DPR 固定**。旋转/窗口变化不会重新计算 backing store；需要时监听 `tt.onWindowResize` 后重建 canvas/context。
- **单实例**。adapter 是进程级单例，一个 JS 上下文只能跑一个 Bevy App；多开需要改成实例化。
- **输入**：触摸映射为 pointer；鼠标/键盘在模拟器可用，但真机以触摸为准。手柄 API 在非 secure context 下不可用。
- **资源加载**：`fetch` 对字符串直接返回路径，适合 `AssetServer` 读取包内资源；复杂 HTTP/缓存逻辑需要自己补。
- **wasm-bindgen 版本敏感**。`patch_glue.py` 针对 0.2.129；升级后必须重新验证。

## 移植到别的 wasm 引擎的方法论

这套东西可以按层复用，不一定非要 Bevy：

1. **先让 wasm 实例化**：用 `TTWebAssembly.instantiate(path, imports)`，确认 `.br` 解压和 import 类型都通过。
2. **再让 glue 初始化**：`--target no-modules`，用 `glue({ module_or_path })`；不要用 `--target web` 的 `fetch` 路径。
3. **补 DOM 形状**：从报错倒推，先 `window/document`，再 `canvas/style/getComputedStyle`，最后 observer。
4. **补构造器**：所有 `dyn_into` 目标都要有可 `instanceof` 的全局构造器，用 `Symbol.hasInstance` 比伪造 prototype 稳。
5. **补 GPU surface**：确认 `getContext('webgl2')` 返回对象能通过 `WebGL2RenderingContext` 的 `instanceof`。
6. **补事件循环**：RAF、visibility、pointer/touch；每加一个都看 console 是否出现 `RefCell already borrowed` 或递归。
7. **最后才调性能/体积**：wasm-opt 特性、Brotli、分包。

排查时优先看开发者工具 console；抖音的 Rust panic 会以 `panicked at ...` 出现，但 wasm `unreachable` 的 stack 只有 wasm 函数号，需要结合 Bevy 日志定位。
