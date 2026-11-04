# 宿主契约（adapter v0.2.2）

这份文档描述 `runtime/adapter.js` 向游戏暴露的**稳定接口**。游戏侧（通常是
`Host` / `HostEnv` 之类的小模块）只依赖这里列出的全局变量、单位约定和状态机，
不直接调用 `tt.*`。

> 适用版本：`v0.2.2`。升级适配层后，先对照本文末尾的「升级检查清单」回归。

## 1. 启动顺序

```text
package/game.js
  └─ runtime/bootstrap.js : start({ glue, wasm, ... })
       ├─ runtime/adapter.js : install()        ← 先安装 window/document/canvas/WebGL2/输入
       ├─ require('./<name>.js')                ← 再加载 wasm-bindgen glue
       └─ glue({ module_or_path: '<name>.wasm.br' })
            └─ TTWebAssembly.instantiate(...) → Rust main() → Bevy App
```

顺序不能反：winit 在 wasm 初始化阶段就会访问 `window`、`document` 和 canvas。
`bootstrap.start()` 已经处理好这个顺序，游戏只需要保证 `glue` 是一个函数，
而不是提前 `require` 好的对象。

### Rust 侧怎么读这些全局

抖音 wasm 宿主里的 `js_sys::global()` **不是** JS 侧的 `GameGlobal`，而且
`js_sys::eval` 在真机/模拟器上会报 `eval is not a function`。可靠写法：

```rust
fn js_window() -> JsValue {
    js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("window"))
        .unwrap_or(JsValue::UNDEFINED)
}
```

adapter 会把 shim `window` 安装到 wasm 可见的 globalThis 上，所以通过
`Reflect::get(window, "__bevy_douyin_Canvas")` 就能读到下面的全局。

## 2. 单位

同一个屏幕上存在三种坐标，混用是最常见的 bug 来源：

| 单位 | 谁在用 | 范围 |
| --- | --- | --- |
| **CSS px** | `SafeArea`、`tt.getSystemInfoSync()`、触摸原始坐标 | 屏幕逻辑尺寸（例如 393×852） |
| **canvas px** | `Canvas.width/height`、winit 的 `cursor_position()`、触摸转换后的 `offsetX/offsetY` | 设计画布（例如 720×1561） |
| **world** | Bevy 相机、`Transform` | 由相机 `ScalingMode` 决定 |

`Canvas` 是**逻辑尺寸**，不是 backing store。默认 `devicePixelRatio: 1`，
因此 canvas px 与 world 通常 1:1；把 dpr 设成 2 只会放大实际像素缓冲，
CSS 尺寸和 `Canvas` 都不变。

### 画布尺寸公式

```text
W = round(max(designW, designH * screenW / screenH))
H = round(max(designH, designW * screenH / screenW))
```

竖屏 720×1280、屏幕 393×852 时得到 `720×1561`。这样画布始终与屏幕同宽高比，
宿主拉伸画布时不会变形，Rust 侧也不需要 letterbox。

## 3. 全局变量

全部发布在 `GameGlobal` 和 shim `window` 上，键名为 `globalPrefix + Name`，
默认前缀 `__bevy_douyin_`。

| 名称 | 类型 | 方向 | 说明 |
| --- | --- | --- | --- |
| `Canvas` | `{width,height}` | JS → Rust | 逻辑画布尺寸（canvas px） |
| `SafeArea` | `{left,top,right,bottom,screenWidth,screenHeight,menuButton}` | JS → Rust | 安全区 inset，**CSS px** |
| `Theme` | `"dark"` / `"light"` | 双向 | 当前主题 |
| `SetTheme(value)` | 函数 | Rust → JS | 手动切换主题；会停止跟随系统 |
| `AdStatus` | 字符串 | JS → Rust | `idle` / `loading` / `ended` / `skipped` / `error` / `unavailable` |
| `ShowAd(kind)` | 函数 → `bool` | Rust → JS | 请求激励视频；`false` 表示本次不可用 |
| `AdMock` | `bool` | JS → Rust | 最近一次 `ShowAd` 是否走了本地 mock（v0.2.2 新增） |

`SetTheme` / `ShowAd` 在 JS 侧是函数，Rust 通过 `Reflect::apply` 或
`js_sys::Function::call1` 调用。

### SafeArea 与胶囊按钮

`SafeArea` 的四个 inset 已经 clamp 到合理范围，单位是 CSS px。
`menuButton` 是 `tt.getMenuButtonBoundingClientRect()` 的原样结果，**可能为
`null`**（部分宿主/模拟器不提供）。

推荐的顶部安全区：

```text
top_css = max(SafeArea.top, menuButton ? menuButton.bottom : 0)
```

只取 `SafeArea.top` 会让顶部分数/按钮被抖音胶囊挡住。转换到 world：

```text
world_per_css = designWidth / SafeArea.screenWidth
inset_world   = inset_css * world_per_css
```

## 4. 指针与触摸

adapter 监听 `tt.onTouchStart/Move/End/Cancel`，合成 `pointerdown/move/up/cancel`
（不派发 `touchstart`，winit 不需要）。winit 0.30 读取的是 **`offsetX/offsetY`**，
adapter 按 `x * (W / screenW)`、`y * (H / screenH)` 把它换算到 canvas px；
`devicePixelRatio` 保持 1，因此 `window.cursor_position()` 直接是 canvas px。

注意事项：

- 触摸**不会**产生 `MouseButton` 事件。需要点击语义时，同时处理
  `Touches::iter_just_pressed()` 和 `MouseButton::Left`（模拟器里鼠标可用）。
- 同一个触点可能同时触发 pointerdown 和后续合成的鼠标事件，且可能落在
  **相邻帧**。同帧去重不够，建议 200–300ms + 少量位移阈值去重。
- 多点触控会带 `pointerId`；`isPrimary` 只对第一个触点成立。

## 5. 主题

- 启动时读取 `tt.getSystemInfoSync()` 的 `theme` / `themeMode` / `colorScheme`，
  没有则回退 `dark`。
- 每 4 秒轮询一次系统主题；`tt.onThemeChange` 也会更新。
- `SetTheme(value)` 会设置 `manualTheme`，**永久停止**跟随系统，直到宿主触发
  `tt.onThemeChange`（目前没有恢复跟随的 API）。
- 主题是展示偏好，不建议写入存档后又在启动时 `SetTheme`，否则用户永远无法
  回到系统主题。

## 6. 激励视频（含本地 mock）

### 配置项（`runtime.start` / `adapter.install`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `adUnitId` | `''` | 激励视频广告位；为空时走 mock |
| `adUnitIds` | 无 | 按 `kind` 分广告位，优先级高于 `adUnitId` |
| `mockAds` | `true` | 无广告位时是否启用本地 mock |
| `mockAdResult` | `'ended'` | mock 结果：`ended` / `skipped` / `error` |
| `mockAdDelay` | `600` | mock 的 loading 时长（ms） |

### 状态机

```text
idle ──ShowAd──> loading ──> ended     ← 完整看完，应发奖
                     ├────> skipped   ← 提前关闭，不发奖
                     ├────> error     ← 展示/加载失败，不发奖
                     └────> unavailable（mockAds=false 且无广告位）
```

`ShowAd(kind)` 同步返回 `bool`：

- `true`：请求已受理，之后轮询 `AdStatus`。
- `false`：本次没有可用的广告（`AdStatus` 会是 `error` 或 `unavailable`）。

适配层**没有内置超时**：真机上广告 SDK 可能既不回调 `onClose` 也不回调
`onError`。调用方必须自己设上限（建议 15–30 秒），超时后按失败处理，避免
按钮永久卡在 loading。

### mock 行为

没有广告位（或宿主没有 `tt.createRewardedVideoAd`）且 `mockAds !== false` 时：

1. 立即把 `AdStatus` 置为 `loading`；
2. 等待 `mockAdDelay`；
3. 置为 `mockAdResult`（默认 `ended`）；
4. `ShowAd` 返回 `true`。

控制台会打印 `ad mock kind=... result=... delay=...ms`，用于确认当前走的是
mock 还是真实广告。要测试失败路径，把 `mockAdResult` 改成 `skipped` / `error`；
要确认「没有广告位」的 UI，设 `mockAds: false`。

### 接真实广告位

1. 在抖音开放平台创建激励视频广告位；
2. 把 `adUnitId` 填进 `game.js`；
3. 真机预览/发布后测试完整观看、提前关闭、无填充三条路径；
4. 不要把测试广告位带到线上。

## 7. 存储

`window.localStorage` / `window.sessionStorage` 是同一个对象（会话存储没有
独立语义），底层通过 `tt.setStorageSync` / `tt.getStorageSync` 持久化：

```js
localStorage.setItem(key, value)   // value 会被 String() 转换
localStorage.getItem(key)          // 不存在返回 null
localStorage.removeItem(key)
localStorage.clear()
localStorage.length / key(i)
```

注意：

- adapter 启动时会把 `tt.getStorageInfoSync().keys` 里的**所有键**读进内存；
- `clear()` 会删除这些键（包括 adapter 自己的 `__boot_notes` 和同应用其他
  模块的数据），不要用它做「只清游戏存档」；
- 建议给键加命名空间，例如 `pong.best_rally`；
- 存储是异步引擎上的同步 API，频繁写入会掉帧，存档适合在回合结束时写。

## 8. 生命周期

- `tt.onShow` / `tt.onHide` 会更新 `visibilityState` 并派发 `visibilitychange`；
- shim 的 `focus` / `blur` 也跟随前后台切换；
- 宿主切后台会暂停 RAF，恢复后第一帧的 `dt` 可能非常大。逻辑更新应使用
  `Time<Virtual>`，并对 `dt` 做上限（例如 0.1s）；纯表现效果可以用
  `Time<Real>`。

## 9. 不支持 / 已知限制

- 只支持 WebGL2，没有 WebGL1 / WebGPU 回退；
- 没有音频 shim（`AudioContext` 等），Bevy audio 需要自行补；
- 没有多线程，Bevy 任务池走单线程；
- DPR 固定，旋转/窗口变化不会重建 backing store；
- adapter 是进程级单例，一个 JS 上下文只能跑一个 Bevy App；
- `fetch` 对字符串直接返回包内路径，复杂 HTTP/缓存逻辑需要自己补；
- wasm-bindgen 版本敏感：`tools/patch_glue.py` 针对 **0.2.129**。

## 10. 升级检查清单

升级 adapter 后至少回归：

- [ ] `Canvas` 尺寸与屏幕比例一致，world 与 canvas px 仍 1:1；
- [ ] `SafeArea` 顶部不被胶囊遮挡；
- [ ] 触摸拖动球拍/角色，点击按钮只触发一次；
- [ ] 深色/浅色主题切换，且启动时不会被存档强制覆盖；
- [ ] 无广告位时 mock 能走完 `loading → ended`；
- [ ] 有广告位时 `ended` / `skipped` / `error` 三条路径都可复现；
- [ ] 存档写入后重启仍能读回；
- [ ] 切后台再回来，画面恢复且没有巨大 `dt` 跳变。
