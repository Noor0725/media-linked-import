# Media Linked Import

一个桌面端 Obsidian 辅助插件：导入 YouTube 或 Bilibili 视频字幕，将字幕文件关联到 Media Extended 视频笔记；平台字幕不可用时，提供本地语音转写路径。

这是独立的辅助插件，不是 Media Extended 或 OB English Learner 的官方组件，也不包含这两个插件的代码。

## 功能与处理方式

- **YouTube**：先用 `yt-dlp` 检查字幕情况。有字幕时调用已启用的 OB English Learner 导入；确认无字幕时尝试下载原声音轨并使用本地 Whisper 转写。无法确定字幕状态时，仍会尝试常规导入，也可以手动运行“YouTube 本地语音转写（手动）”。
- **Bilibili**：优先读取平台提供的字幕；没有取得字幕时，尝试下载音频并在本地转写。平台权限或接口变化可能影响导入。
- 生成 SRT 和视频笔记，使用 Media Extended 的 `subtitles` 属性关联；笔记中的时间链接可用于跳转到视频对应位置。
- 自动识别音频主要语言。语音识别可能有错，需要人工核对；若 YouTube 存在多个音轨而无法确认原声，插件会停止而不是随意选择。

## 环境要求

- Obsidian 桌面版，最低版本见 `manifest.json`。这是桌面插件，不支持 Obsidian 移动端。
- [Media Extended](https://github.com/aidenlx/media-extended)：用于媒体播放器与字幕；如需与学习笔记联动，可另行配置相关学习插件。
- [OB English Learner](https://github.com/dashell7/OB-English-Learner)：**常规 YouTube 字幕导入需要安装并启用**；本地转写和 Bilibili 导入不依赖此步骤。
- 本地语音转写目前面向 **Apple Silicon 的 macOS**，需要 [uv](https://docs.astral.sh/uv/getting-started/installation/)；YouTube 本地转写还需要 Node.js，uv 会准备 Python 3.11 或更高版本及隔离依赖。[yt-dlp](https://github.com/yt-dlp/yt-dlp) 用于 YouTube 字幕预检查和 Bilibili 本地转写。
- Obsidian 从图形界面启动时可能读不到终端中的全部路径。插件会查找常见安装位置；如果提示找不到工具，请检查安装位置、Obsidian 可见的 PATH，并重启 Obsidian。
- 需要网络访问视频平台。首次转写还需要下载 Python 依赖和 `mlx-community/whisper-turbo` 模型，下载量和耗时可能较大。模型与依赖会保存在本机缓存；临时音频在处理完成后清理。YouTube 本地转写使用隔离的 yt-dlp 和 EJS，不会隐式读取浏览器登录信息。

本地转写在本机进行；获取视频、字幕和下载模型会联网。其他插件的翻译、AI 服务等功能由其各自的设置决定，可能涉及第三方服务和费用。

## 手动安装

1. 下载仓库中的 `manifest.json`、`main.js`、`local_transcribe.py` 三个文件。
2. 将三个文件放入目标知识库的 `.obsidian/plugins/media-linked-import/` 文件夹；如知识库使用自定义配置目录，请放入对应目录的 `plugins/media-linked-import/`。
3. 在 Obsidian 设置中启用社区插件，然后启用 **Media Linked Import**。按需要安装并启用上述配套插件和命令行工具。
4. 若原有知识库或插件设置很重要，请先备份，再在测试知识库中验证。

这是手动安装说明，不能据此认为插件已经上架 Obsidian 社区插件市场。

## 使用

1. 复制 YouTube / Bilibili 视频链接，或者 Bilibili 的 BV 号。
2. 点击 Obsidian 左侧的字幕图标，或通过命令面板运行“导入视频字幕；无字幕时本地转写”。若剪贴板没有可识别的链接，会出现输入框。
3. 等待导入完成，插件会尝试打开关联的视频笔记。
4. 若 YouTube 自动检查无法判定且常规导入未成功，可手动运行“YouTube 本地语音转写（手动）”。

默认会使用 `media-lib/` 保存视频笔记、`02-Subtitles/` 保存字幕，并使用 `media-lib/_Import-Staging/` 作为 YouTube 常规导入的临时区域。路径目前写在代码中，界面中尚不可配置。

## 使用前请留意

- YouTube 本地转写对已有同名字幕使用不同名称，并保留已有的视频笔记正文与字幕链接；常规 YouTube 导入通过 OB English Learner 和临时笔记处理，行为与本地转写不同。
- **重新导入同一 Bilibili 视频会更新同名生成的 SRT、视频笔记的字幕正文和部分属性。** 原有 `^^^words` 之后的学习记录会保留；如果原正文没有该标记，正文可能被替换。请先备份自己修改过的字幕和笔记。
- 语音转写依赖外部工具、视频可访问性和平台接口，失败时请查看 Obsidian 开发者控制台；公开、受限或多音轨视频的处理结果可能不同。
- 本项目目前的自动测试覆盖部分分支与数据保留逻辑，不代表已在所有 Obsidian 版本和系统上验证。

## 测试

在项目目录运行：

```bash
node tests/youtube.cjs
node tests/runtime.cjs
python3 tests/transcribe.py
```

这些是使用模拟对象的逻辑测试，不会下载视频或加载 Whisper 模型，也不能替代在真实 Obsidian 环境中的端到端测试。

## 相关项目

- [Media Extended](https://github.com/aidenlx/media-extended)
- [OB English Learner](https://github.com/dashell7/OB-English-Learner)
- [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
