const {
  Modal,
  Notice,
  Plugin,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  requestUrl,
} = require("obsidian");

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const os = require("os");
const path = require("path");

const execFileAsync = promisify(execFile);

const LEARNER_PLUGIN_ID = "ob-english-learner";
const MEDIA_FOLDER = "media-lib";
const STAGING_FOLDER = "media-lib/_Import-Staging";
const SUBTITLE_FOLDER = "02-Subtitles";

// GUI apps on macOS may receive a shorter PATH than the user's terminal.
// Check common user install locations as well, without assuming a username.
function findExecutable(name) {
  const home = os.homedir();
  const directories = [
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  const pythonHome = path.join(home, "Library", "Python");
  try {
    const versions = fs.readdirSync(pythonHome, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)*$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    directories.push(...versions.map((version) => path.join(pythonHome, version, "bin")));
  } catch (_) {
    // This directory is optional (for example, on a fresh installation).
  }
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch (_) {
        // Try the next location.
      }
    }
  }
  return null;
}

const UV_PATH = findExecutable("uv");
const YT_DLP_PATH = findExecutable("yt-dlp");
const LOCAL_MODEL = "mlx-community/whisper-turbo";

class VideoUrlModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
    this.url = "";
  }

  onOpen() {
    this.titleEl.setText("一键导入并关联视频字幕");
    new Setting(this.contentEl)
      .setName("视频链接")
      .setDesc("粘贴 YouTube、B站视频链接，或直接输入 BV 号")
      .addText((text) => {
        text.setPlaceholder("https://www.bilibili.com/video/BV...");
        text.onChange((value) => {
          this.url = value.trim();
        });
        text.inputEl.focus();
      });
    new Setting(this.contentEl).addButton((button) => {
      button.setButtonText("导入并关联").setCta().onClick(() => {
        this.close();
        this.onSubmit(this.url);
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = class MediaLinkedImportPlugin extends Plugin {
  async onload() {
    this.addRibbonIcon("captions", "一键导入并关联视频字幕", () => {
      this.importFromClipboard();
    });

    this.addCommand({
      id: "import-youtube-and-link-subtitles",
      name: "一键导入并关联视频字幕（YouTube / B站）",
      callback: () => this.importFromClipboard(),
    });

    this.addCommand({
      id: "import-video-and-link-subtitles",
      name: "导入视频字幕；无字幕时本地转写",
      callback: () => this.importFromClipboard(),
    });

    this.addCommand({
      id: "transcribe-youtube-locally",
      name: "YouTube 本地语音转写（手动）",
      callback: () => this.importFromClipboard({ forceLocal: true }),
    });
  }

  async importFromClipboard(options = {}) {
    let url = "";
    try {
      url = (await navigator.clipboard.readText()).trim();
    } catch (error) {
      console.warn("[Media Linked Import] Clipboard read failed", error);
    }

    if (this.getYouTubeId(url) || this.getBilibiliId(url)) {
      await this.importAndLink(url, options);
      return;
    }

    new VideoUrlModal(this.app, async (value) => {
      await this.importAndLink(value, options);
    }).open();
  }

  async importAndLink(inputUrl, options = {}) {
    if (options.forceLocal && !this.getYouTubeId(inputUrl)) {
      new Notice("本地 YouTube 转写需要有效的 YouTube 视频链接");
      return;
    }
    if (this.getBilibiliId(inputUrl)) {
      await this.importBilibiliAndLink(inputUrl);
      return;
    }
    if (this.getYouTubeId(inputUrl)) {
      if (options.forceLocal) {
        await this.importYouTubeLocally(inputUrl);
        return;
      }
      await this.importYouTubeAndLink(inputUrl);
      return;
    }
    new Notice("这不是有效的 YouTube 或 B站视频链接");
  }

  async importYouTubeAndLink(inputUrl) {
    const videoId = this.getYouTubeId(inputUrl);
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    // Only a successful metadata lookup can establish that captions are absent.
    // A network/authentication error is not evidence of missing subtitles.
    const checking = new Notice("正在检查 YouTube 字幕...", 0);
    let subtitleStatus;
    try {
      subtitleStatus = await this.inspectYouTubeSubtitles(url);
    } finally {
      checking.hide();
    }
    if (subtitleStatus === "absent") {
      await this.importYouTubeLocally(url);
      return;
    }
    if (subtitleStatus === "unknown") {
      new Notice("无法预先确认字幕；若常规导入失败，可运行“YouTube 本地语音转写（手动）”", 8000);
    }

    const learner = this.app.plugins.getPlugin(LEARNER_PLUGIN_ID);
    if (!learner || typeof learner.importVideo !== "function") {
      new Notice("请先启用 OB English Learner 插件");
      return;
    }

    const progress = new Notice("正在下载 YouTube 字幕并准备关联...", 0);
    const originalVideoFolder = learner.settings.videoFolder;
    let stagingNote = null;

    try {
      learner.settings.videoFolder = STAGING_FOLDER;
      await learner.importVideo(url);
      stagingNote = await this.waitForStagingNote(videoId, 30000);
    } catch (error) {
      console.error("[Media Linked Import] YouTube import failed", error);
      progress.hide();
      new Notice(`导入失败：${error.message}`);
      return;
    } finally {
      learner.settings.videoFolder = originalVideoFolder;
    }

    try {
      const subtitleFiles = await this.waitForSubtitles(
        stagingNote.basename,
        10 * 60 * 1000,
      );
      progress.setMessage("字幕已下载，正在绑定播放器...");

      const mediaNote =
        this.findYouTubeMediaNote(videoId) ||
        (await this.createYouTubeMediaNote(url, stagingNote));

      await this.mergeTranscriptBody(mediaNote, stagingNote);
      await this.linkSubtitleFiles(mediaNote, subtitleFiles);
      await this.cleanupStaging(stagingNote);
      await this.app.workspace.getLeaf(false).openFile(mediaNote);

      progress.hide();
      new Notice("导入完成：YouTube 字幕已与视频双向关联");

      this.followAdditionalSubtitles(mediaNote, stagingNote.basename).catch(
        (error) => console.warn("[Media Linked Import] Follow-up failed", error),
      );
    } catch (error) {
      console.error("[Media Linked Import] YouTube linking failed", error);
      progress.hide();
      new Notice(`关联失败：${error.message}`);
    }
  }

  async inspectYouTubeSubtitles(url) {
    if (!YT_DLP_PATH) return "unknown";
    try {
      const { stdout } = await execFileAsync(
        YT_DLP_PATH,
        ["--ignore-config", "--no-cache-dir", "--no-playlist", "--skip-download", "--no-warnings", "--dump-single-json", url],
        { timeout: 60000, maxBuffer: 50 * 1024 * 1024 },
      );
      const info = JSON.parse(stdout);
      if (info.id !== this.getYouTubeId(url)) return "unknown";
      if (!("subtitles" in info) || !("automatic_captions" in info)) return "unknown";
      const hasTracks = (tracks) => Object.values(tracks || {}).some(
        (entries) => Array.isArray(entries) && entries.length > 0,
      );
      return hasTracks(info.subtitles) || hasTracks(info.automatic_captions)
        ? "present"
        : "absent";
    } catch (error) {
      console.warn("[Media Linked Import] Could not determine YouTube subtitle availability", error.message);
      return "unknown";
    }
  }

  async importYouTubeLocally(inputUrl) {
    const videoId = this.getYouTubeId(inputUrl);
    if (!videoId) {
      new Notice("这不是有效的 YouTube 视频链接");
      return;
    }
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const progress = new Notice("正在下载原声音轨并本地转写；首次运行可能需要下载依赖或模型...", 0);
    try {
      this.assertLocalRuntime({ youtube: true });
      const local = await this.transcribeLocally(url, videoId, { youtube: true });
      if (!local.metadata || local.metadata.videoId !== videoId) {
        throw new Error("转写结果与请求的视频不一致");
      }
      if (!Array.isArray(local.segments) || !local.segments.length) {
        throw new Error("没有生成可用字幕");
      }
      const sourceName = `local-${this.safeToken(local.language || "auto")}`;
      const subtitle = await this.saveYouTubeLocalSrt(videoId, sourceName, local.segments);
      const note = await this.upsertYouTubeLocalMediaNote(url, local.metadata, local.segments, subtitle);
      await this.app.workspace.getLeaf(false).openFile(note);
      progress.hide();
      new Notice("完成：YouTube 原声音轨已本地转写并关联字幕", 6000);
      return { note, subtitle };
    } catch (error) {
      console.error("[Media Linked Import] YouTube local transcription failed", error);
      progress.hide();
      new Notice(`YouTube 本地转写失败：${error.message}`, 10000);
      return null;
    }
  }

  async importBilibiliAndLink(inputUrl) {
    const videoId = this.getBilibiliId(inputUrl);
    const url = `https://www.bilibili.com/video/${videoId}`;
    const progress = new Notice("正在检查 B站官方字幕...", 0);

    try {
      const platform = await this.fetchBilibiliData(videoId);
      let metadata = platform.metadata;
      let segments = platform.segments;
      let sourceName = platform.sourceName;
      let localGenerated = false;

      if (!segments.length) {
        this.assertLocalRuntime();
        progress.setMessage(
          "没有官方字幕，正在本地转写；首次运行需下载模型，请耐心等待...",
        );
        const local = await this.transcribeBilibiliLocally(url, videoId);
        metadata = { ...metadata, ...local.metadata, videoId };
        segments = local.segments;
        sourceName = `local-${this.safeToken(local.language || "auto")}`;
        localGenerated = true;
      } else {
        progress.setMessage("找到 B站官方字幕，正在生成 SRT...");
      }

      if (!segments.length) throw new Error("没有生成可用字幕");

      const subtitleFile = await this.saveBilibiliSrt(
        videoId,
        sourceName,
        segments,
      );
      const mediaNote = await this.upsertBilibiliMediaNote(
        url,
        metadata,
        segments,
        subtitleFile,
      );

      await this.app.workspace.getLeaf(false).openFile(mediaNote);
      progress.hide();
      new Notice(
        localGenerated
          ? "完成：本地字幕已生成并关联视频"
          : "完成：B站官方字幕已关联视频",
        6000,
      );
    } catch (error) {
      console.error("[Media Linked Import] Bilibili import failed", error);
      progress.hide();
      new Notice(`B站字幕导入失败：${error.message}`, 10000);
    }
  }

  async fetchBilibiliData(videoId) {
    const referer = `https://www.bilibili.com/video/${videoId}`;
    const viewJson = await this.fetchBilibiliJson(
      `https://api.bilibili.com/x/web-interface/view?bvid=${videoId}`,
      referer,
    );
    if (viewJson?.code !== 0 || !viewJson?.data) {
      throw new Error(viewJson?.message || "无法读取 B站视频信息");
    }

    const data = viewJson.data;
    const playerJson = await this.fetchBilibiliJson(
      `https://api.bilibili.com/x/player/v2?bvid=${videoId}&cid=${data.cid}`,
      referer,
    );
    const subtitleList = playerJson?.data?.subtitle?.subtitles || [];
    const selected =
      subtitleList.find((item) => String(item.lan || "").startsWith("zh")) ||
      subtitleList[0];
    let segments = [];
    let sourceName = "bilibili-cc";

    if (selected?.subtitle_url) {
      let subtitleUrl = selected.subtitle_url;
      if (subtitleUrl.startsWith("//")) subtitleUrl = `https:${subtitleUrl}`;
      const subtitleJson = await this.fetchBilibiliJson(subtitleUrl, referer);
      segments = (subtitleJson?.body || [])
        .map((item) => ({
          start: Number(item.from) || 0,
          end: Number(item.to) || Number(item.from) + 1,
          text: String(item.content || "").trim(),
        }))
        .filter((item) => item.text);
      sourceName = `bilibili-${this.safeToken(selected.lan || "cc")}`;
    }

    return {
      metadata: {
        videoId,
        title: data.title || videoId,
        creator: data.owner?.name || "",
        creatorUrl: data.owner?.mid
          ? `https://space.bilibili.com/${data.owner.mid}`
          : "",
        description: data.desc || "",
        duration: Number(data.duration) || 0,
        thumbnailUrl: data.pic || "",
        publishedAt: data.pubdate
          ? new Date(data.pubdate * 1000).toISOString().slice(0, 10)
          : "",
      },
      segments,
      sourceName,
    };
  }

  async fetchBilibiliJson(url, referer) {
    const headers = {
      Referer: referer,
      "User-Agent": "Mozilla/5.0",
    };
    try {
      const response = await requestUrl({ url, headers });
      return response.json;
    } catch (error) {
      const message = String(error?.message || error || "");
      console.warn(
        `[Media Linked Import] Obsidian request blocked; retrying with curl: ${message}`,
      );
      const { stdout } = await execFileAsync(
        "/usr/bin/curl",
        [
          "--fail",
          "--silent",
          "--show-error",
          "--location",
          "--max-time",
          "30",
          "--user-agent",
          "Mozilla/5.0",
          "--referer",
          referer,
          url,
        ],
        { maxBuffer: 20 * 1024 * 1024 },
      );
      try {
        return JSON.parse(stdout);
      } catch (parseError) {
        throw new Error(`B站返回了无法解析的数据：${parseError.message}`);
      }
    }
  }

  assertLocalRuntime(options = {}) {
    if (!UV_PATH || !fs.existsSync(UV_PATH)) {
      throw new Error("找不到 uv。请先安装 uv，并重新启动 Obsidian。");
    }
    if (!options.youtube && (!YT_DLP_PATH || !fs.existsSync(YT_DLP_PATH))) {
      throw new Error("找不到 yt-dlp。请先安装 yt-dlp，并重新启动 Obsidian。");
    }
    if (!fs.existsSync(this.localScriptPath())) {
      throw new Error(`找不到本地转写脚本：${this.localScriptPath()}`);
    }
  }

  async transcribeBilibiliLocally(url, videoId) {
    return await this.transcribeLocally(url, videoId);
  }

  async transcribeLocally(url, videoId, options = {}) {
    const resultPath = path.join(
      os.tmpdir(),
      `media-linked-import-${videoId}-${Date.now()}.json`,
    );
    try {
      const dependencies = ["run", ...(options.youtube ? ["--no-project", "--python", ">=3.11"] : []), "--with", "mlx-whisper", "--with", "imageio-ffmpeg"];
      if (options.youtube) {
        // An isolated downloader keeps the user's installed yt-dlp untouched.
        // The default extra includes the official EJS component needed by YouTube.
        dependencies.push("--with", "yt-dlp[default]>=2026.10.26");
      }
      await execFileAsync(
        UV_PATH,
        [
          ...dependencies,
          this.localScriptPath(),
          "--url",
          url,
          "--yt-dlp",
          YT_DLP_PATH || "yt-dlp",
          "--model",
          LOCAL_MODEL,
          "--language",
          "",
          "--result-json",
          resultPath,
          ...(options.youtube ? ["--python-ytdlp"] : []),
        ],
        {
          timeout: 2 * 60 * 60 * 1000,
          maxBuffer: 50 * 1024 * 1024,
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
        },
      );
      const result = JSON.parse(await fs.promises.readFile(resultPath, "utf8"));
      if (!Array.isArray(result.segments)) {
        throw new Error("本地转写结果格式错误");
      }
      return result;
    } catch (error) {
      const details = String(error.stderr || error.stdout || error.message || error)
        .trim()
        .split("\n")
        .slice(-4)
        .join(" ");
      throw new Error(details || "本地转写失败");
    } finally {
      await fs.promises.unlink(resultPath).catch(() => {});
    }
  }

  localScriptPath() {
    const basePath = this.app.vault.adapter.getBasePath();
    return path.join(
      basePath,
      this.app.vault.configDir || ".obsidian",
      "plugins",
      this.manifest.id,
      "local_transcribe.py",
    );
  }

  async saveBilibiliSrt(videoId, sourceName, segments) {
    await this.ensureVaultFolder(SUBTITLE_FOLDER);
    const fileName = `${videoId}.${this.safeToken(sourceName)}.srt`;
    const filePath = normalizePath(`${SUBTITLE_FOLDER}/${fileName}`);
    const content = this.toSrt(segments);
    const existing = this.app.vault.getFileByPath(filePath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return existing;
    }
    return await this.app.vault.create(filePath, content);
  }

  async saveYouTubeLocalSrt(videoId, sourceName, segments) {
    await this.ensureVaultFolder(SUBTITLE_FOLDER);
    const base = `${videoId}.${this.safeToken(sourceName)}`;
    const content = this.toSrt(segments);
    for (let number = 1; number < 10000; number += 1) {
      const suffix = number === 1 ? "" : `-${number}`;
      const filePath = normalizePath(`${SUBTITLE_FOLDER}/${base}${suffix}.srt`);
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      if (!existing) return await this.app.vault.create(filePath, content);
      if (existing instanceof TFile && await this.app.vault.read(existing) === content) {
        return existing;
      }
    }
    throw new Error("无法为本地字幕找到不冲突的文件名");
  }

  async upsertYouTubeLocalMediaNote(url, metadata, segments, subtitleFile) {
    await this.ensureVaultFolder(MEDIA_FOLDER);
    let note = this.findYouTubeMediaNote(metadata.videoId);
    let isNew = false;
    if (!note) {
      const title = this.mediaFileName(metadata.title || metadata.videoId) || metadata.videoId;
      let filePath = normalizePath(`${MEDIA_FOLDER}/${title}.md`);
      if (this.app.vault.getAbstractFileByPath(filePath)) {
        filePath = normalizePath(`${MEDIA_FOLDER}/${title}-${metadata.videoId}.md`);
      }
      for (let number = 2; this.app.vault.getAbstractFileByPath(filePath); number += 1) {
        filePath = normalizePath(`${MEDIA_FOLDER}/${title}-${metadata.videoId}-${number}.md`);
      }
      note = await this.app.vault.create(filePath, "---\n---\n");
      isNew = true;
    }

    const subtitleLink = `[[${subtitleFile.path}]]`;
    await this.app.fileManager.processFrontMatter(note, (frontmatter) => {
      if (!frontmatter["mx-uid"]) frontmatter["mx-uid"] = this.makeUid();
      if (!frontmatter.video) frontmatter.video = url;
      if (!frontmatter.title) frontmatter.title = metadata.title || metadata.videoId;
      if (!frontmatter.creator && metadata.creator) frontmatter.creator = metadata.creator;
      if (!frontmatter.creator_url && metadata.creatorUrl) frontmatter.creator_url = metadata.creatorUrl;
      if (!frontmatter.duration && metadata.duration) frontmatter.duration = Math.round(metadata.duration);
      if (!frontmatter.cover_url && metadata.thumbnailUrl) frontmatter.cover_url = metadata.thumbnailUrl;
      if (!frontmatter.published_at && metadata.publishedAt) frontmatter.published_at = metadata.publishedAt;
      if (!frontmatter.aspect_ratio) frontmatter.aspect_ratio = "16 / 9";
      if (!frontmatter.source) frontmatter.source = "youtube";
      const current = Array.isArray(frontmatter.subtitles)
        ? frontmatter.subtitles
        : frontmatter.subtitles ? [frontmatter.subtitles] : [];
      frontmatter.subtitles = [...new Set([...current, subtitleLink])];
      if (frontmatter.langr === undefined) frontmatter.langr = true;
      if (frontmatter["langr-pos"] === undefined) frontmatter["langr-pos"] = "1";
    });

    const content = await this.app.vault.read(note);
    // Existing article/word/notes content is never replaced by a retry.
    if (isNew || !this.bodyOf(content).trim()) {
      await this.app.vault.modify(
        note,
        `${this.frontmatterOf(content)}\n\n${this.youtubeTranscriptBody(url, segments)}\n`,
      );
    }
    return note;
  }

  youtubeTranscriptBody(url, segments) {
    const lines = segments.map((segment) => {
      const seconds = Math.max(0, Math.floor(Number(segment.start) || 0));
      const text = String(segment.text || "").replace(/\s+/g, " ").trim();
      return `[${this.shortTime(seconds)}](${url}&t=${seconds}s) ${text}`;
    });
    return ["^^^article", "", "## 本地语音转写（自动识别，可能有误）", "", ...lines, "", "^^^words", "", "", "^^^notes"].join("\n");
  }

  async upsertBilibiliMediaNote(url, metadata, segments, subtitleFile) {
    await this.ensureVaultFolder(MEDIA_FOLDER);
    let note = this.findBilibiliMediaNote(metadata.videoId);
    let isNew = false;

    if (!note) {
      let fileName = this.mediaFileName(metadata.title || metadata.videoId);
      let notePath = normalizePath(`${MEDIA_FOLDER}/${fileName}.md`);
      if (this.app.vault.getAbstractFileByPath(notePath)) {
        notePath = normalizePath(
          `${MEDIA_FOLDER}/${fileName}-${metadata.videoId}.md`,
        );
      }
      note = await this.app.vault.create(notePath, "---\n---\n");
      isNew = true;
    }

    const subtitleLink = `[[${subtitleFile.path}]]`;
    await this.app.fileManager.processFrontMatter(note, (frontmatter) => {
      if (!frontmatter["mx-uid"]) frontmatter["mx-uid"] = this.makeUid();
      frontmatter.video = url;
      frontmatter.title = metadata.title || metadata.videoId;
      frontmatter.creator = metadata.creator || "";
      if (metadata.creatorUrl) frontmatter.creator_url = metadata.creatorUrl;
      if (metadata.description) frontmatter.description = metadata.description;
      if (metadata.duration) frontmatter.duration = Math.round(metadata.duration);
      if (metadata.thumbnailUrl) frontmatter.cover_url = metadata.thumbnailUrl;
      if (metadata.publishedAt) frontmatter.published_at = metadata.publishedAt;
      frontmatter.aspect_ratio = "16 / 9";
      frontmatter.source = "bilibili";
      frontmatter.bvid = metadata.videoId;
      const current = Array.isArray(frontmatter.subtitles)
        ? frontmatter.subtitles
        : frontmatter.subtitles
          ? [frontmatter.subtitles]
          : [];
      const generatedPrefix = `[[${SUBTITLE_FOLDER}/${metadata.videoId}.local-`;
      const retained = current.filter(
        (item) => !String(item).startsWith(generatedPrefix),
      );
      frontmatter.subtitles = [...new Set([...retained, subtitleLink])];
      frontmatter.langr = true;
      frontmatter["langr-pos"] = "1";
    });

    const currentContent = await this.app.vault.read(note);
    const currentBody = this.bodyOf(currentContent);
    const freshBody = this.bilibiliTranscriptBody(url, segments);
    const body = isNew
      ? freshBody
      : this.replaceArticlePreservingStudyNotes(currentBody, freshBody);
    await this.app.vault.modify(
      note,
      `${this.frontmatterOf(currentContent)}\n\n${body}\n`,
    );
    return note;
  }

  replaceArticlePreservingStudyNotes(currentBody, freshBody) {
    const freshWordsIndex = freshBody.indexOf("^^^words");
    const freshArticle =
      freshWordsIndex >= 0 ? freshBody.slice(0, freshWordsIndex) : freshBody;
    const currentWordsIndex = currentBody.indexOf("^^^words");
    const studyTail =
      currentWordsIndex >= 0
        ? currentBody.slice(currentWordsIndex)
        : "^^^words\n\n\n^^^notes\n\n";
    return `${freshArticle.trimEnd()}\n\n${studyTail.trimStart()}`.trimEnd();
  }

  findBilibiliMediaNote(videoId) {
    return this.app.vault.getMarkdownFiles().find((file) => {
      if (!file.path.startsWith(`${MEDIA_FOLDER}/`)) return false;
      if (file.path.startsWith(`${STAGING_FOLDER}/`)) return false;
      const frontmatter =
        this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      return (
        frontmatter.bvid === videoId ||
        this.getBilibiliId(frontmatter.video || frontmatter.url) === videoId
      );
    });
  }

  bilibiliTranscriptBody(url, segments) {
    const lines = segments.map((segment) => {
      const seconds = Math.max(0, Math.floor(Number(segment.start) || 0));
      const label = this.shortTime(seconds);
      const text = String(segment.text || "").replace(/\s+/g, " ").trim();
      return `[${label}](${url}?t=${seconds}) ${text}`;
    });
    return [
      "^^^article",
      "",
      "## 字幕",
      "",
      ...lines,
      "",
      "^^^words",
      "",
      "",
      "^^^notes",
    ].join("\n");
  }

  toSrt(segments) {
    return (
      segments
        .map((segment, index) => {
          const start = Math.max(0, Number(segment.start) || 0);
          const end = Math.max(start + 0.1, Number(segment.end) || start + 1);
          const text = String(segment.text || "").replace(/\r?\n/g, " ").trim();
          return `${index + 1}\n${this.srtTime(start)} --> ${this.srtTime(end)}\n${text}`;
        })
        .join("\n\n") + "\n"
    );
  }

  srtTime(seconds) {
    const millis = Math.max(0, Math.round(seconds * 1000));
    const hours = Math.floor(millis / 3600000);
    const minutes = Math.floor((millis % 3600000) / 60000);
    const secs = Math.floor((millis % 60000) / 1000);
    const ms = millis % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  }

  shortTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
      : `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  getBilibiliId(value) {
    if (!value) return null;
    const match = String(value).match(/BV[a-zA-Z0-9]{10}/);
    return match ? match[0] : null;
  }

  getYouTubeId(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      if (url.hostname === "youtu.be") return url.pathname.slice(1) || null;
      if (url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com")) {
        if (url.pathname === "/watch") return url.searchParams.get("v");
        const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/);
        return match ? match[1] : null;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  async waitForStagingNote(videoId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const note = this.app.vault
        .getMarkdownFiles()
        .find((file) => {
          if (!file.path.startsWith(`${STAGING_FOLDER}/`)) return false;
          const frontmatter =
            this.app.metadataCache.getFileCache(file)?.frontmatter || {};
          return this.getYouTubeId(frontmatter.url || frontmatter.video) === videoId;
        });
      if (note) return note;
      await this.sleep(500);
    }
    throw new Error("没有找到刚生成的视频笔记");
  }

  async waitForSubtitles(baseName, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const files = this.findSubtitleFiles(baseName);
      if (files.length > 0) return files;
      await this.sleep(1500);
    }
    throw new Error("字幕下载超时，请稍后再试");
  }

  findSubtitleFiles(baseName) {
    const names = [
      `${baseName} - EN.srt`,
      `${baseName} - ZH.srt`,
      `${baseName} - EN-ZH.srt`,
    ];
    return names
      .map((name) =>
        this.app.vault.getFileByPath(normalizePath(`${SUBTITLE_FOLDER}/${name}`)),
      )
      .filter((file) => file instanceof TFile);
  }

  findYouTubeMediaNote(videoId) {
    return this.app.vault.getMarkdownFiles().find((file) => {
      if (!file.path.startsWith(`${MEDIA_FOLDER}/`)) return false;
      if (file.path.startsWith(`${STAGING_FOLDER}/`)) return false;
      const frontmatter =
        this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      return this.getYouTubeId(frontmatter.video || frontmatter.url) === videoId;
    });
  }

  async createYouTubeMediaNote(url, stagingNote) {
    const stagingCache =
      this.app.metadataCache.getFileCache(stagingNote)?.frontmatter || {};
    const title = stagingCache.title || stagingNote.basename;
    let fileName = this.mediaFileName(title);
    let path = normalizePath(`${MEDIA_FOLDER}/${fileName}.md`);
    if (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${MEDIA_FOLDER}/${fileName}-${this.getYouTubeId(url)}.md`);
    }

    const note = await this.app.vault.create(path, "---\n---\n");
    await this.app.fileManager.processFrontMatter(note, (frontmatter) => {
      frontmatter["mx-uid"] = this.makeUid();
      frontmatter.video = url;
      frontmatter.title = title;
      if (stagingCache.channel) frontmatter.creator = stagingCache.channel;
      if (stagingCache.cover) frontmatter.cover = `[[${stagingCache.cover}]]`;
      frontmatter.aspect_ratio = "16 / 9";
    });
    return note;
  }

  async mergeTranscriptBody(mediaNote, stagingNote) {
    const [mediaContent, stagingContent] = await Promise.all([
      this.app.vault.read(mediaNote),
      this.app.vault.read(stagingNote),
    ]);
    const mediaBody = this.bodyOf(mediaContent);
    const stagingBody = this.bodyOf(stagingContent);
    if (!stagingBody.includes("^^^article")) return;
    if (mediaBody.includes("^^^article") && mediaBody.trim().length >= 200) return;
    await this.app.vault.modify(
      mediaNote,
      `${this.frontmatterOf(mediaContent)}\n\n${stagingBody.trim()}\n`,
    );
  }

  async linkSubtitleFiles(mediaNote, subtitleFiles) {
    const links = subtitleFiles.map((file) => `[[${file.path}]]`);
    await this.app.fileManager.processFrontMatter(mediaNote, (frontmatter) => {
      frontmatter.subtitles = links;
      frontmatter.langr = true;
      frontmatter["langr-pos"] = "1";
    });
  }

  async followAdditionalSubtitles(mediaNote, baseName) {
    let previousCount = this.findSubtitleFiles(baseName).length;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline && previousCount < 3) {
      await this.sleep(5000);
      const files = this.findSubtitleFiles(baseName);
      if (files.length > previousCount) {
        previousCount = files.length;
        await this.linkSubtitleFiles(mediaNote, files);
      }
    }
  }

  async cleanupStaging(stagingNote) {
    await this.app.vault.trash(stagingNote, false);
    const folder = this.app.vault.getAbstractFileByPath(STAGING_FOLDER);
    if (folder instanceof TFolder && folder.children.length === 0) {
      await this.app.vault.delete(folder);
    }
  }

  async ensureVaultFolder(folderPath) {
    const normalized = normalizePath(folderPath);
    if (!this.app.vault.getAbstractFileByPath(normalized)) {
      await this.app.vault.createFolder(normalized);
    }
  }

  frontmatterOf(content) {
    const match = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
    return match ? match[0] : "---\n---";
  }

  bodyOf(content) {
    return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  }

  safeToken(value) {
    return (
      String(value || "subtitle")
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "subtitle"
    );
  }

  mediaFileName(title) {
    return title
      .replace(/[\\/:*?"<>|#^[\]]/g, "_")
      .replace(/[. ]+$/g, "")
      .slice(0, 150)
      .trim();
  }

  makeUid() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
};
