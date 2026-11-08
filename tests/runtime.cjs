const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "media-import-runtime-test-"));
try {
  const uv = path.join(fixture, ".local", "bin", "uv");
  const ytdlp = path.join(fixture, "Library", "Python", "3.13", "bin", "yt-dlp");
  for (const file of [uv, ytdlp]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  }
  const obsidian = { Plugin: class {}, Modal: class {}, Notice: class {} };
  const context = {
    module: { exports: {} },
    exports: {},
    require: (name) => name === "obsidian" ? obsidian : name === "os" ? { ...os, homedir: () => fixture } : require(name),
    process: { ...process, env: { PATH: "" } },
    console,
    URL,
    Buffer,
    setTimeout,
  };
  vm.runInNewContext(source + "\nmodule.exports.runtimePaths = { UV_PATH, YT_DLP_PATH };", context);
  assert.equal(context.module.exports.runtimePaths.UV_PATH, uv);
  assert.equal(context.module.exports.runtimePaths.YT_DLP_PATH, ytdlp);
  console.log("PASS portable executable lookup in GUI-style empty PATH");
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
