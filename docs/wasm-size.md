# wasm 体积优化记录

> 说明：本文源自 `starter-v1` 的实测记录，结论仍适用，但具体字节数会随版本和
> 代码规模变化；当前构建命令与产物名以 README 为准。

这份记录来自把模板实际用于一个 2D 抖音小游戏后的体积优化。目标是在不改变运行时行为的前提下，优先缩小首包，其次减少构建产物的解析/启动成本。

## 结果

在同一台 macOS 机器、Bevy 0.20、`wasm-bindgen 0.2.129` 下测得：

| 产物 | 优化前（模板 README 记录） | 优化后（本分支） | 变化 |
| --- | ---: | ---: | ---: |
| `bevy_game.wasm.br` | ~3.2 MB | **2,362,702 B（约 2.25 MiB）** | 约 -26% |
| `bevy_game.js`（glue） | ~119 KB | **50,055 B** | 约 -58% |
| `runtime/adapter.js` | ~33 KB | **13,448 B** | 约 -59% |
| 输出包总大小 | ~3.35 MB | **约 2.43 MB** | 约 -27% |

具体数字会随 Bevy、binaryen、brotli 版本和代码规模变化，重点看相对变化。

## 做了什么

### 1. 只启用实际用到的 Bevy 插件

模板原来的 `features = ["2d"]` 很方便，但会带进 UI、picking、scene、PNG 解码、gizmo、后处理等 starter 并不实例化的插件。当前 `Cargo.toml` 改为：

```toml
bevy = { version = "0.20", default-features = false, features = [
  "std",
  "async_executor",
  "bevy_asset",
  "bevy_window",
  "bevy_winit",
  "webgl2",
  "bevy_camera",
  "bevy_render",
  "bevy_core_pipeline",
  "bevy_sprite",
  "bevy_sprite_render",
] }
```

注意：

- 这不是“越小越好”的绝对清单，而是 **starter 当前代码所需的最小集合**。用到文字要加 `bevy_text`；用 `bevy_ui`、`picking`、`scene`、`png` 时也要把对应 feature 加回来。
- 保留了 `async_executor`，因为模板文档承诺 `AssetServer` 可用。确认游戏完全不使用资源加载后，可以再去掉它；本项目本体在无资源加载时去掉了它，进一步省了一点体积。
- 模板默认保留 `bevy_log`，方便排查启动问题。若确认不需要 Bevy 日志，可再移除 `bevy_log`；Bevy 的 `info!` / `warn!` 也要一起处理。本项目本体用 `web_sys::console::log_1` 写了一个很小的 facade，代价是失去 `RUST_LOG` 过滤。

### 2. `wasm-opt` 加 `--converge`

```bash
wasm-opt -Oz \
  --converge \
  --enable-bulk-memory \
  --enable-mutable-globals \
  --enable-sign-ext \
  --enable-nontrapping-float-to-int \
  --enable-reference-types \
  --enable-multivalue \
  in.wasm -o out.wasm
```

`--converge` 会反复跑优化直到不动点，静态数据/字符串布局还能再挤出一点。这里仍然**不能**用 `--all-features`：binaryen 133 会生成 compact imports，抖音 wasm 引擎会报 `unknown import kind 0x7f`。

### 3. Brotli 窗口改为 22

```bash
brotli -q 11 -w 22 -f -o game.wasm.br game.wasm
```

窗口 22 仍是标准 Brotli 格式，不需要解码器扩展；对这类 wasm，比 CLI 默认的 24 略好。实际收益约几 KB，但零风险。

### 4. 可选 JS 压缩

`tools/build.sh` 在 glue patch 完成后，如果检测到 `esbuild`，会把 `<name>.js` 和 `runtime/adapter.js` 压一遍；没有 esbuild 就跳过，构建仍成功。

```bash
# 推荐安装方式之一
npm install -g esbuild
# 或者使用项目内已有的 esbuild
npx --no-install esbuild --version
```

想调试 glue 时加 `--no-minify`。

## 试过但不建议的方案

- `opt-level = "s"`：本项目的实测结果反而比 `"z"` 大约 3.2 MB（Brotli 后），不要仅凭直觉切换。
- `wasm-opt --strip-debug --merge-similar-functions`：Brotli 后没有稳定收益，个别组合甚至略大。
- `wasm-bindgen --remove-name-section --remove-producers-section`：对最终 Brotli 体积没有稳定帮助；name section 对调试还有价值。
- `--closed-world` / `--directize`：对当前 wasm-bindgen 输出没有收益，且增加兼容风险。
- 非 BMP 字符/彩色 emoji 字体：与体积无关，但踩过坑；抖音模拟器的文本渲染对 cmap format 12 不友好，像素字体应使用 BMP 码位（例如 `U+25C9`）。

## 还能继续往哪里挖

- 去掉 `bevy_log` + 自带日志 facade（需要接受没有日志过滤；本项目本体实测可再省一部分）。
- 去掉 `async_executor`（需要确认没有 `AssetServer` 加载）。
- 替换 `bevy_text`/字体栈（本项目保留了中文像素字体，约 35 KB；文字系统本身比字体大）。
- `build-std` / `panic_immediate_abort`：需要 nightly，收益和工具链稳定性要自己权衡。
- 分包/首包裁剪：抖音主包有 4 MB 限制，当前约 2.43 MB 仍有余量。

## 验证

- `cargo check`（native）通过。
- `cargo build --release --target wasm32-unknown-unknown` 通过。
- 抖音开发者工具模拟器（852×393 横屏 starter）编译、启动、旋转方块和触摸跟随正常。
- `--no-minify-js` 与默认压缩两种路径都已覆盖。

## 复现

```bash
./build.sh
ls -lh <out-dir>/<name>.js <out-dir>/<name>.wasm.br <out-dir>/runtime/adapter.js
```
