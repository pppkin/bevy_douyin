# 小游戏工程模板

复制 `package/` 到你的游戏仓库，改掉占位符，就能得到一个可导入抖音开发者工具的小游戏目录。

```bash
mkdir -p platforms/douyin/package
cp -R addons/bevy-douyin/template/package/. platforms/douyin/package/
```

## 安装

不需要额外安装。模板只有三个文件：

| 文件 | 需要改什么 |
| --- | --- |
| `game.js` | `name`、`wasm`、`glue`、`adUnitId`，可选 `globalPrefix` / `storagePrefix` |
| `game.json` | 需要不同行为时再改方向和状态栏 |
| `project.config.json` | `appid` 和 `projectname` |
| `icon.png` | 自己放一张；模板故意不带 |

## 使用示例

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

## 配置说明

### `game.js`

- `name` 只作为日志前缀，例如 `[bevy-douyin:my_game]`。
- `wasm` 必须和构建的 `--name` 一致，产物是 `<name>.wasm.br`。
- `glue` 必须和构建的 `--name` 一致，产物是 `<name>.js`。
- `--wasm` 只选择 Rust 产物 stem（`target/.../release/<stem>.wasm`），不改 JS 文件名。
- `canvas` 要和 runtime 创建的选择器一致；`width` / `height` 是设计分辨率。
- `globalPrefix` 默认 `__bevy_douyin_`。改了它，Rust 侧的全局常量也要改。
- `storagePrefix` 可选，例如 `mygame.`。它会隔离 `localStorage`，并让 `clear()` 只清这个前缀。
- `AD_UNIT_ID` 留空时走本地 mock：`RequestAd` 返回 ticket，`AdStatus` 在
  `mockAdDelay`（默认 600ms）后变成 `ended`，`AdResult` 带回同一张 ticket。
  用 `mockAdResult`（`ended` / `skipped` / `error`）测试失败分支；设
  `mockAds: false` 可让空广告位返回 `unavailable`。

### 构建输出

构建会把 `<name>.js`、`<name>.wasm.br`、`runtime/` 和 `assets/` 写到 `game.js`
旁边。它不会覆盖 `game.js`、`game.json`、`project.config.json`、`icon.png`。

## Rust 侧

Rust 入口留在游戏仓库里，因为每个游戏的 host 实现不同。适配层在
`globalPrefix` 下发布这些全局：

| 全局 | 方向 | 说明 |
| --- | --- | --- |
| `Version` | JS → Rust | 适配层版本，如 `"0.4.0"` |
| `Layout` / `Canvas` / `SafeArea` | JS → Rust | 画布、安全区、屏幕和序号 |
| `ViewportSeq` | JS → Rust | 尺寸变化时递增 |
| `Theme` / `ThemeManual` / `ThemeSource` | JS → Rust | 主题状态 |
| `SetTheme(value)` / `FollowTheme()` | Rust → JS | 手动覆盖 / 恢复跟随系统 |
| `RequestAd(kind)` | Rust → JS | 返回 ticket；`0` 表示忙或失败 |
| `ShowAd(kind)` | Rust → JS | `RequestAd(kind) > 0` 的兼容包装 |
| `AdTicket` / `AdResult` | JS → Rust | 用 ticket 对账终态结果 |
| `AdStatus` / `AdReason` / `AdLastError` | JS → Rust | 广告状态细节 |
| `AppState` / `AppStateSeq` | JS → Rust | 前台 / 后台 |
| `AdMock` | JS → Rust | 这一单是否走了 mock |

读全局时使用 `js_sys::global()` 加 `Reflect::get("window")`。不要用 `eval`，也不要
依赖 `GameGlobal`。完整字段见 [`../docs/host-contract.md`](../docs/host-contract.md)。

### 音频

适配层在全局安装了 `AudioContext`，Bevy 打开 `bevy_audio` + `wav` feature 后
可以直接播放。抖音包内文件不能用 `fetch` 读取，小音效用 `include_bytes!`
编进 wasm，再通过 `Assets<AudioSource>` 交给 `AudioPlayer`。
