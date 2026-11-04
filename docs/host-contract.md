# 宿主契约（adapter v0.4.0）

这份文档描述 `runtime/adapter.js` 向游戏暴露的**稳定接口**。游戏侧（通常是
`Host` / `HostEnv` 之类的小模块）只依赖这里列出的全局变量、单位约定和状态机，
不直接调用 `tt.*`。

> 适用版本：`v0.4.0`。升级适配层后，先对照本文末尾的「升级检查清单」回归。

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

`Canvas` / `Layout.canvas` 是**逻辑尺寸**，不是 backing store。默认
`devicePixelRatio: 1`，因此 canvas px 与 world 通常 1:1；把 dpr 设成 2 只会
放大实际像素缓冲，CSS 尺寸和 `Canvas` 都不变。

### 画布尺寸公式

```text
W = round(max(designW, designH * screenW / screenH))
H = round(max(designH, designW * screenH / screenW))
```

竖屏 720×1280、屏幕 393×852 时得到 `720×1561`。这样画布始终与屏幕同宽高比，
宿主拉伸画布时不会变形，Rust 侧也不需要 letterbox。

## 3. 全局变量

全部发布在 `GameGlobal` 和 shim `window` 上，键名为 `globalPrefix + Name`，
默认前缀 `__bevy_douyin_`。启动完成后 `Version` 一定是可读的。

| 名称 | 类型 | 方向 | 说明 |
| --- | --- | --- | --- |
| `Version` | `string` | JS → Rust | 适配层版本，例如 `"0.4.0"` |
| `Config` | 对象 | JS → Rust | 归一化后的启动配置，见下表 |
| `Layout` | 对象 | JS → Rust | `{canvas, safeArea, screen, devicePixelRatio, seq}` |
| `Canvas` | `{width,height}` | JS → Rust | 逻辑画布尺寸（canvas px），`Layout.canvas` 的扁平副本 |
| `SafeArea` | 对象 | JS → Rust | 安全区 inset / 屏幕 / 胶囊，**CSS px** |
| `ViewportSeq` | `number` | JS → Rust | 画布/安全区变化序号，启动为 1，之后每次 resize +1 |
| `Theme` | `"dark"` / `"light"` | 双向 | 当前主题 |
| `ThemeManual` | `bool` | JS → Rust | 是否处于手动主题模式 |
| `ThemeSource` | `"system"` / `"manual"` | JS → Rust | 当前主题来源 |
| `SetTheme(value)` | 函数 | Rust → JS | 切换主题并进入手动模式 |
| `FollowTheme()` | 函数 | Rust → JS | 清除手动模式，恢复跟随系统 |
| `RequestAd(kind)` | 函数 → `number` | Rust → JS | 请求激励视频，返回 ticket；`0` = 忙/失败 |
| `ShowAd(kind)` | 函数 → `bool` | Rust → JS | `RequestAd(kind) > 0` 的兼容包装 |
| `AdTicket` | `number` | JS → Rust | 当前（或最近一次）请求的票据 |
| `AdResult` | 对象/null | JS → Rust | 最近一次终态 `{ticket,kind,status,reason,isEnded,mock}` |
| `AdStatus` | `string` | JS → Rust | `idle/loading/ended/skipped/error/unavailable` |
| `AdReason` | `string` | JS → Rust | 终态原因，例如 `mock` / `timeout` / `no-ad-unit` |
| `AdLastError` | `string` | JS → Rust | 最近一次错误原因；成功开始时清空 |
| `AdMock` | `bool` | JS → Rust | **本次**广告是否走 mock（不是能力开关） |
| `AppState` | `"foreground"` / `"background"` | JS → Rust | 前后台状态 |
| `AppStateSeq` | `number` | JS → Rust | 前后台变化序号，启动为 1 |
| `LastError` | `string` | JS → Rust | 适配层最近一次内部错误（安装/resize 等） |

`Config` 字段：

```js
{
  name, designWidth, designHeight, globalPrefix, storagePrefix,
  devicePixelRatio, adTimeoutMs, mockAds, adUnitConfigured, automaticResize
}
```

`mockAds` 表示「无广告位时是否允许 mock」，不能拿 `AdMock` 判断能力：
一次真实广告结束后 `AdMock` 也是 `false`。

## 4. SafeArea 与胶囊按钮

`SafeArea` 的四个 inset 已经 clamp 到合理范围，单位是 CSS px。0.3 新增：

| 字段 | 说明 |
| --- | --- |
| `width` / `height` | 安全区尺寸（`screenW - left - right` 等） |
| `statusBarHeight` | 状态栏高度，可能为 0 |
| `menuButton` | 归一化后的胶囊 `{left,top,right,bottom,width,height}` 或 `null` |
| `hasMenuButton` | 胶囊是否可用 |

推荐的顶部安全区：

```text
top_css = max(SafeArea.top, menuButton ? menuButton.bottom : 0)
```

只取 `SafeArea.top` 会让顶部分数/按钮被抖音胶囊挡住。转换到 world：

```text
world_per_css = designWidth / SafeArea.screenWidth
inset_world   = inset_css * world_per_css
```

### 布局变化

`tt.onWindowResize` 触发时，adapter 会重新计算画布、安全区和胶囊，更新
backing store、`window.innerWidth/innerHeight` 与 `screen`，然后：

1. `ViewportSeq += 1`；
2. 重新发布 `Canvas` / `SafeArea` / `Layout`；
3. 在 shim `window` 上派发 `resize`。

游戏若支持横竖屏/分屏，应在启动时记录 `ViewportSeq`，每帧或收到 resize 后
比较，重新构建 `View`、相机投影和布局。竖屏锁定的小游戏可以只在启动时读一次
`Layout`，示例 Pong 就是这种做法。

## 5. 指针与触摸

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

## 6. 主题

- 启动时读取 `tt.getSystemInfoSync()` 的 `theme` / `themeMode` / `colorScheme`，
  没有则回退 `dark`。
- 每 4 秒轮询一次系统主题；`tt.onThemeChange` 也会更新。
- `SetTheme(value)` 设置手动模式：`ThemeManual=true`、`ThemeSource='manual'`。
  之后系统主题变化**不会**覆盖它，直到调用 `FollowTheme()`。
- `FollowTheme()` 清除手动模式，立即重新读取系统主题，并恢复 4 秒轮询。
- 如果游戏把主题写进存档，启动时应只在**用户确实手动选过**时调用
  `SetTheme`；否则保持跟随系统。

## 7. 激励视频（含本地 mock）

### 配置项（`runtime.start` / `adapter.install`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `adUnitId` | `''` | 激励视频广告位；为空时走 mock |
| `adUnitIds` | 无 | 按 `kind` 分广告位，优先级高于 `adUnitId` |
| `mockAds` | `true` | 无广告位时是否启用本地 mock |
| `mockAdResult` | `'ended'` | mock 结果：`ended` / `skipped` / `error` |
| `mockAdDelay` | `600` | mock 的 loading 时长（ms） |
| `adTimeoutMs` | `30000` | 适配层等待终态的上限（ms） |

### 用 ticket 关联回调

0.3 起推荐 `RequestAd` + `AdResult`，而不是只看 `AdStatus`：

```text
ticket = RequestAd("rewarded")      // >0 受理；0 表示忙或失败
AdTicket == ticket                  // 适配层回显
AdStatus == "loading"               // 广告开始
... 用户看完/关闭/超时 ...
AdResult == {ticket, status, reason, isEnded, mock}
```

只有 `AdResult.ticket == 本次 ticket` 时才能发奖。这样即使上一个广告的
`onClose` 延迟到达，也不会误触发新的奖励。

### 状态机

```text
idle ──RequestAd──> loading ──> ended         ← 完整看完，应发奖
                       ├──────> skipped       ← 提前关闭，不发奖
                       ├──────> error         ← 展示/加载/超时失败，不发奖
                       └──────> unavailable   ← mockAds=false 且无广告位
```

`RequestAd(kind)` 返回 `number`：

- `>0`：受理成功，这个数字就是本次 ticket；
- `0`：已有广告在进行，或没有可用广告（此时 `AdStatus` 为 `error` /
  `unavailable`，`AdResult` 保持 `null`）。

`ShowAd(kind)` 是兼容包装，返回 `RequestAd(kind) > 0`。

### 超时

适配层内部会在 `adTimeoutMs`（默认 30 秒）后主动结束：

```text
AdStatus  = "error"
AdReason  = "timeout"
AdLastError = "timeout"
AdResult  = { ticket, status: "error", reason: "timeout", ... }
```

游戏侧仍建议保留一个略大的兜底计时（例如 32 秒），防止适配层本身没有启动
（例如 `RequestAd` 是旧版本）。

### mock 行为

没有广告位（或宿主没有 `tt.createRewardedVideoAd`）且 `mockAds !== false` 时：

1. `RequestAd` 返回一个新 ticket，`AdStatus` 立即为 `loading`；
2. 等待 `mockAdDelay`（默认 600ms）；
3. 置为 `mockAdResult`（默认 `ended`），发布 `AdResult`；
4. `AdMock` 为 `true`。

控制台会打印 `ad mock kind=... result=... delay=...ms ticket=N` 和
`ad mock finished: ...`。要测试失败路径，把 `mockAdResult` 改成 `skipped` /
`error`；要确认「没有广告位」的 UI，设 `mockAds: false`。

### 接真实广告位

1. 在抖音开放平台创建激励视频广告位；
2. 把 `adUnitId` 填进 `game.js`；
3. 真机预览/发布后测试完整观看、提前关闭、无填充三条路径；
4. 不要把测试广告位带到线上。

## 8. 存储

`window.localStorage` / `window.sessionStorage` 是同一个对象（会话存储没有
独立语义），底层通过 `tt.setStorageSync` / `tt.getStorageSync` 持久化：

```js
localStorage.setItem(key, value)   // value 会被 String() 转换
localStorage.getItem(key)          // 不存在返回 null
localStorage.removeItem(key)
localStorage.clear()
localStorage.length / key(i)
```

### 命名空间（0.3 新增）

推荐配置 `storagePrefix`（例如 `'pong.'`）：

- 启动时只把以该前缀开头的宿主键载入内存，游戏侧看到的 key 不带前缀；
- `setItem('best')` 实际写入 `pong.best`；
- `clear()` 只删除该前缀下的键，不会碰 `__boot_notes` 或其他模块的数据。

不配置前缀时，`clear()` 只删除**本适配层写过的键**，同样不会清空整个
宿主存储。即便如此，仍建议显式使用前缀，避免不同游戏版本之间互相覆盖。

存储是同步 API，频繁写入会掉帧，存档适合在回合结束时写。

## 9. 生命周期

- `tt.onShow` / `tt.onHide` 更新 `AppState` 与 `AppStateSeq`，并记录日志；
- `visibilitychange`、shim 的 `focus` / `blur` 也跟随前后台切换；
- 宿主切后台会暂停 RAF，恢复后第一帧的 `dt` 可能非常大。逻辑更新应使用
  `Time<Virtual>`，在 `AppState=="background"` 时暂停、回前台再恢复，或至少对
  `dt` 做上限（例如 0.1s）；纯表现效果可以用 `Time<Real>`。

## 10. 音频（0.4 新增）

适配层安装了一个全局 `AudioContext` 构造器，Bevy 的
`bevy_audio → rodio → cpal` 会直接走 WebAudio 后端：

```text
AudioPlayer
  └─ rodio 解码 / 混音
       └─ cpal webaudio host
            └─ AudioContext.createBufferSource → destination
```

### 构造顺序

- 优先 `tt.getAudioContext()`（基础库 1.34.0+，返回 W3C 风格的 AudioContext）；
- 没有该 API 时回退到原生 `AudioContext`（模拟器可用）；
- 两者都没有时，构造器抛出 `AudioContext is not available`；
- 首次创建会打印一行 `audio: context ready sampleRate=44100 state=running`。

同一个上下文会被复用；适配层只创建一次。

### 兼容补丁

- 抖音的 `destination` 没有 `setChannelCount`，cpal 在声道数匹配时会调用它；
  适配层补了一个空实现。
- 缓冲区、`currentTime`、`createBufferSource`、`buffer` 属性都使用标准
  WebAudio 语义，不需要额外适配。
- 采样率默认跟随音频设备（模拟器为 44100Hz）。游戏侧不要假设固定采样率。

### 前后台与自动播放

- `tt.onHide` 时 `suspend()`，`tt.onShow` 时 `resume()`；
- 第一次 `tt.onTouchStart` 也会尝试 `resume()`，用于 iOS 的“必须用户手势才能
  出声”限制；
- 如果上下文仍处于 `suspended`，先让玩家点一下屏幕，再播放第一段声音。

### 资源怎么进包

抖音小游戏**不能**通过 `fetch` 或 `FileSystemManager` 读取包内文件
（`readFileSync('game.json')` 会报 `no such file or directory`）。因此：

- 小音效用 `include_bytes!` 编进 wasm，再 `Assets<AudioSource>::add`；
- 长音频/背景音乐可以放远程 CDN，但需要配置抖音的合法域名，并且要自己处理
  网络 `fetch`（适配层的 `fetch` 只是转发原生实现）；
- `AssetServer.load("audio/x.wav")` 在真机上通常拿不到包内文件，不建议依赖。

```rust
let bytes = include_bytes!("../assets/audio/hit.wav");
let sound = assets.add(AudioSource {
    bytes: Arc::from(&bytes[..]),
});
commands.spawn((
    AudioPlayer(sound),
    PlaybackSettings::DESPAWN,
));
```

### 已知限制

- 真机音频只做了 API 级验证，尚未在所有机型上试听；iOS 静音键、蓝牙耳机、
  低端 Android 的采样率差异都可能导致“没有声音”；
- 不支持后台播放；切后台会 `suspend()`；
- 没有 3D 空间音频的额外保证，Bevy 的 `SpatialListener` 仍依赖 WebAudio 实现；
- 解码格式取决于 Cargo feature（`wav` / `vorbis` / `mp3`），没开就会在加载时
  报错。

## 11. 不支持 / 已知限制

- 只支持 WebGL2，没有 WebGL1 / WebGPU 回退；
- 没有多线程，Bevy 任务池走单线程；
- 画布 resize 会重建 backing store，但游戏需要自己重建相机/布局；
- adapter 是进程级单例，一个 JS 上下文只能跑一个 Bevy App；
- `fetch` 只转发原生实现；包内文件无法读取，资源要内嵌或走网络；
- wasm-bindgen 版本敏感：`tools/patch_glue.py` 针对 **0.2.129**。

## 12. 升级检查清单

升级 adapter 后至少回归：

- [ ] `Version` 与预期一致；
- [ ] `Layout.canvas` 与屏幕比例一致，world 与 canvas px 仍 1:1；
- [ ] `SafeArea` 顶部不被胶囊遮挡；
- [ ] 旋转/分屏后 `ViewportSeq` 增长，画布与相机尺寸同步；
- [ ] 触摸拖动球拍/角色，点击按钮只触发一次；
- [ ] 主题：手动选择不被系统切换覆盖，`FollowTheme()` 能恢复跟随；
- [ ] 无广告位时 mock 能走完 `loading → ended`，且 ticket 对得上；
- [ ] 有广告位时 `ended` / `skipped` / `error` / 超时四条路径都可复现；
- [ ] 存档写入后重启仍能读回，`clear()` 不影响其他命名空间；
- [ ] 切后台再回来，画面恢复且没有巨大 `dt` 跳变；
- [ ] 音频：`audio: context ready` 出现，第一次触摸后能出声，切后台再回来不报错。
