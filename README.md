# bevy-douyin-adapter

用 Bevy 0.20 写抖音小游戏时，先接上这一层：它负责浏览器形状的运行时、wasm-bindgen glue 补丁、构建脚本和小游戏工程模板。

这个仓库是**适配层**，不是打开就能玩的项目。想看完整游戏，去
[bevy_douyin_example](https://gitee.com/pppkin/bevy_douyin_example)。

原来的 starter 保留在 `starter` 分支和 `starter-v1` tag；`main` 只放适配层。

## 安装

### 1. 准备工具

需要 Rust、wasm32 目标和下面几个命令行工具。

| 工具 | 用途 |
| --- | --- |
| Rust + `wasm32-unknown-unknown` | 编译 Bevy |
| `wasm-bindgen` 0.2.129 | 生成 JS glue；版本必须和 crate 一致 |
| `wasm-opt`（Binaryen） | 压缩 wasm |
| `brotli` | 生成 `.wasm.br` |
| `python3` | 运行 glue 补丁脚本 |
| `esbuild`（可选） | 压缩生成的 JS |

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
brew install binaryen brotli
brew install esbuild        # 可选
```

### 2. 添加 submodule

在你的游戏仓库根目录执行：

```bash
git submodule add -b main https://gitee.com/pppkin/bevy_douyin.git addons/bevy-douyin
git submodule update --init addons/bevy-douyin
```

固定到发布 tag，构建结果才可复现：

```bash
git -C addons/bevy-douyin checkout adapter-v0.3.0
git add addons/bevy-douyin
git commit -m "chore: pin bevy-douyin adapter v0.3.0"
```

### 3. 复制小游戏工程模板

```bash
mkdir -p platforms/douyin/package
cp -R addons/bevy-douyin/template/package/. platforms/douyin/package/
```

然后改 `game.js` 和 `project.config.json`，再放一张自己的 `icon.png`。字段说明见
[`template/README.md`](template/README.md)。

### 4. 准备 Rust 入口

在游戏仓库里留一个薄壳 crate：

```text
platforms/douyin/
  Cargo.toml
  src/main.rs       # 创建窗口、相机，启动 Bevy
  src/host.rs       # 读适配层全局，封装存档 / 广告 / 安全区
  package/          # 上一步复制的小游戏工程
```

`tt.*` 由适配层调用。Rust 侧只读全局，并通过 `SetTheme`、`FollowTheme`、
`RequestAd` 反向调用适配层。

读全局时使用 `js_sys::global()` 加 `Reflect::get("window")`。不要用 `eval`，也
不要找 `GameGlobal`——在 wasm 环境里两者都不可用。

### 5. 构建

```bash
./addons/bevy-douyin/tools/build.sh \
  --crate platforms/douyin \
  --out platforms/douyin/package \
  --assets assets \
  --name my_game \
  --wasm my_game
```

构建会生成 `<name>.js`、`<name>.wasm.br`、`runtime/` 和 `assets/`。它不会覆盖
`game.js`、`game.json`、`project.config.json`。

### 6. 导入抖音开发者工具

导入 `platforms/douyin/package/`，不要导入仓库根目录。把
`project.config.json` 里的 `appid` 换成自己的小游戏 AppID，再点“编译”。

## 使用示例

`game.js` 只需要启动 runtime：

```js
var runtime = require('./runtime/bootstrap.js');

runtime.start({
  name: 'my_game',
  canvas: '#game-canvas',
  width: 720,
  height: 1280,
  wasm: 'my_game.wasm.br',
  adUnitId: '',
  globalPrefix: '__bevy_douyin_',
  storagePrefix: 'mygame.',
  glue: function () { return require('./my_game.js'); }
});
```

在 Rust 侧读画布和请求广告：

```rust
use wasm_bindgen::JsValue;

// window 是适配层装在 globalThis 上的 shim，不是浏览器的 window。
let window = js_sys::Reflect::get(&js_sys::global(), &"window".into())
    .unwrap_or(JsValue::UNDEFINED);

// 读 __bevy_douyin_Layout，拿到 canvas / safeArea / seq。
let layout = js_sys::Reflect::get(&window, &"__bevy_douyin_Layout".into())
    .unwrap_or(JsValue::UNDEFINED);

// 请求激励视频，返回 ticket；后续用 AdResult 里同一张 ticket 对账。
let request = js_sys::Reflect::get(&window, &"__bevy_douyin_RequestAd".into())
    .ok()
    .and_then(|f| f.dyn_into::<js_sys::Function>().ok());
let ticket = request
    .and_then(|f| f.call1(&window, &"rewarded".into()).ok())
    .and_then(|v| v.as_f64())
    .unwrap_or(0.0);
```

完整的 `Host`、布局换算和广告状态机，见示例仓库的
`platforms/douyin/src/host.rs` 与 `game.rs`。

## 功能特性

- **运行时 shim**：安装 `window`、`document`、canvas、WebGL2、RAF、触摸和存储，让 Bevy 的 winit / wgpu 以为自己在浏览器里。
- **glue 补丁**：把 wasm-bindgen 0.2.129 生成的 ES module 改成抖音可执行的 CommonJS + Promise 形式。
- **一条命令构建**：cargo → wasm-bindgen → wasm-opt → brotli → 补丁 → 拷贝运行时。
- **可复制的工程模板**：`game.js`、`game.json`、`project.config.json` 直接拿走。
- **稳定的宿主契约**：画布、安全区、主题、广告、前后台、存储都有明确全局和版本号。
- **本地广告 mock**：没有广告位也能跑完整的 `loading → ended` 流程。
- **契约测试**：用 Node 的 `vm` 加载真实 `adapter.js`，覆盖广告、主题、视口和存储。

## 配置说明

### `game.js`

| 字段 | 说明 |
| --- | --- |
| `name` | 日志前缀，如 `[bevy-douyin:my_game]` |
| `canvas` | 画布选择器，如 `#game-canvas` |
| `width` / `height` | 设计分辨率；适配层按屏幕比例推导实际画布 |
| `wasm` | 构建产物的 wasm 文件名，如 `my_game.wasm.br` |
| `glue` | 延迟加载 `<name>.js` 的函数 |
| `adUnitId` | 激励视频广告位；留空时走适配层 mock |
| `globalPrefix` | 全局前缀，默认 `__bevy_douyin_`；Rust 侧必须一致 |
| `storagePrefix` | 存储命名空间，如 `mygame.`；`clear()` 只清这个前缀 |
| `mockAds` | 设为 `false` 可关闭 mock，空广告位会返回 `unavailable` |
| `mockAdResult` | `ended` / `skipped` / `error`，用于测试失败分支 |
| `mockAdDelay` | mock 延迟，默认 600ms |
| `adTimeoutMs` | 真实广告超时，默认 30000ms |

### 构建参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--crate DIR` | `.` | Cargo crate 目录 |
| `--out DIR` | `douyin` | 小游戏包输出目录 |
| `--assets DIR` | `<crate>/assets` | 资源目录；不存在就跳过 |
| `--runtime DIR` | 适配层 `runtime/` | 运行时 JS 目录 |
| `--name NAME` | `game` | 输出的 JS / wasm 文件名 |
| `--wasm STEM` | 同 `--name` | Rust 产物 stem |
| `--no-minify` | 关闭 | 保留未压缩 JS，方便看堆栈 |

### 宿主全局

`adapter.install()` 会把下面这些挂在 `GameGlobal` 和 shim `window` 上。

| 全局 | 方向 | 说明 |
| --- | --- | --- |
| `Version` / `Config` | JS → Rust | 版本和归一化配置 |
| `Layout` / `ViewportSeq` | JS → Rust | 画布、安全区、屏幕、dpr、变更序号 |
| `Canvas` / `SafeArea` | JS → Rust | 0.2 兼容的扁平字段 |
| `Theme` / `ThemeManual` / `ThemeSource` | JS → Rust | 主题状态 |
| `SetTheme` / `FollowTheme` | Rust → JS | 手动覆盖 / 恢复跟随系统 |
| `RequestAd` / `AdResult` | 双向 | ticket 请求与终态结果 |
| `AdStatus` / `AdReason` / `AdLastError` | JS → Rust | 广告状态细节 |
| `AppState` / `AppStateSeq` | JS → Rust | 前台 / 后台 |
| `AdMock` | JS → Rust | 这一单是否走了 mock |

完整字段和语义见 [`docs/host-contract.md`](docs/host-contract.md)。

## 目录结构

```text
runtime/
  adapter.js        DOM / canvas / WebGL2 / RAF / 输入 shim
  bootstrap.js      先装 shim，再加载 wasm glue
tools/
  build.sh          cargo + wasm-bindgen + wasm-opt + brotli + 补丁
  patch_glue.py     把 wasm-bindgen 0.2.129 的输出改到抖音可执行
template/
  package/          game.js / game.json / project.config.json 模板
  README.md         模板字段和接入说明
docs/
  host-contract.md  宿主契约
  how-it-works.md   shim 分层和原理
  troubleshooting.md 已知错误与真机问题
  wasm-size.md      包体积与裁剪
tests/
  adapter.test.js   运行时契约测试
```

## FAQ / 故障排查

**构建时报 `patch_glue.py` 找不到字符串？**
检查 `wasm-bindgen` crate 和 CLI 是否都是 0.2.129。版本不一致时，生成的 glue
结构会变，补丁无法匹配。

**wasm-opt 后报 `unknown import kind 0x7f`？**
不要给 `wasm-opt` 加 `--all-features`。`tools/build.sh` 已经列出抖音支持的
feature 组合，直接用它。

**第一帧正常，随后黑屏？**
检查三件事：`RenderErrorHandler` 是否返回 `RenderErrorPolicy::Ignore`、
`Msaa` 是否关闭、窗口是否使用 `CompositeAlphaMode::Opaque`。

**读不到画布 / 安全区 / 存档？**
不要在 Rust 里用 `eval` 或 `GameGlobal`。改用 `js_sys::global()` 加
`Reflect::get("window")`。

**点一次按钮触发两次？**
触摸会同时产生 pointer 和合成鼠标事件，而且可能落在相邻两帧。按时间和距离做
去重，示例使用 250ms / 24 世界单位。

**广告点了没反应？**
先看 `RequestAd` 是否返回非 0 ticket，再看 `AdResult` 的 `status` 和 `reason`。
空广告位默认走 600ms mock；设了 `mockAds: false` 才会返回 `unavailable`。

更多症状见 [`docs/troubleshooting.md`](docs/troubleshooting.md)。

## 贡献指南

1. 修改 `runtime/adapter.js` 后运行 `npm test`，确保 19 个契约测试全部通过。
2. 新增行为时，在 `tests/adapter.test.js` 加一条对应测试。
3. 面向游戏的接口发生变化时，同步更新 `docs/host-contract.md`、`README.md` 和 `CHANGELOG.md`。
4. 运行时保持 ES5 写法，不要引入构建期转译。
5. 发布前打 tag，例如 `adapter-v0.3.0`，并推送 tag。

## 许可证

WTFPL，见 [`LICENSE`](LICENSE)。runtime 和 glue 补丁源自
`pppkin/bevy_douyin`；本仓库保留可复用的适配层，并把原始 starter 留在
`starter` 分支。
