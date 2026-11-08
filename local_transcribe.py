#!/usr/bin/env python3
"""Download video audio and transcribe it locally with MLX Whisper."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse
import wave

import imageio_ffmpeg
import mlx_whisper
import numpy as np


def run(command: list[str], *, capture: bool = False, attempts: int = 3) -> str:
    last_error = ""
    for attempt in range(attempts):
        result = subprocess.run(
            command,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if result.returncode == 0:
            return (result.stdout or "").strip() if capture else ""
        last_error = (result.stderr or result.stdout or "command failed").strip()
        if attempt + 1 < attempts:
            time.sleep(2 * (attempt + 1))
    tail = " ".join(last_error.splitlines()[-6:])
    raise RuntimeError(tail)


def load_pcm_wav(wav_path: Path) -> np.ndarray:
    with wave.open(str(wav_path), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise RuntimeError("Expected 16-bit mono WAV after conversion")
        frames = audio.readframes(audio.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def curl_json(url: str, referer: str) -> dict:
    raw = run(
        [
            "/usr/bin/curl",
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
        capture=True,
    )
    return json.loads(raw)


def bilibili_fallback(url: str) -> tuple[dict, str]:
    match = re.search(r"BV[a-zA-Z0-9]{10}", url)
    if not match:
        raise RuntimeError("Could not extract a Bilibili BV id")
    video_id = match.group(0)
    referer = f"https://www.bilibili.com/video/{video_id}"
    view = curl_json(
        f"https://api.bilibili.com/x/web-interface/view?bvid={video_id}",
        referer,
    )
    data = view.get("data") or {}
    if view.get("code") != 0 or not data.get("cid"):
        raise RuntimeError(view.get("message") or "Bilibili metadata unavailable")

    play = curl_json(
        "https://api.bilibili.com/x/player/playurl"
        f"?bvid={video_id}&cid={data['cid']}&qn=64&fnval=16&fourk=1",
        referer,
    )
    play_data = play.get("data") or {}
    audio_items = ((play_data.get("dash") or {}).get("audio") or [])
    if audio_items:
        best_audio = max(audio_items, key=lambda item: item.get("bandwidth") or 0)
        audio_url = best_audio.get("baseUrl") or best_audio.get("base_url") or ""
    else:
        durl_items = play_data.get("durl") or []
        audio_url = (durl_items[0].get("url") if durl_items else "") or ""
    if not audio_url:
        raise RuntimeError("Bilibili play API did not return an audio stream")

    owner = data.get("owner") or {}
    pubdate = int(data.get("pubdate") or 0)
    metadata = {
        "id": video_id,
        "title": data.get("title") or video_id,
        "uploader": owner.get("name") or "",
        "uploader_url": (
            f"https://space.bilibili.com/{owner['mid']}" if owner.get("mid") else ""
        ),
        "description": data.get("desc") or "",
        "duration": data.get("duration") or 0,
        "thumbnail": data.get("pic") or "",
        "upload_date": time.strftime("%Y%m%d", time.localtime(pubdate)) if pubdate else "",
    }
    return metadata, audio_url


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--yt-dlp", required=True)
    parser.add_argument("--python-ytdlp", action="store_true")
    parser.add_argument("--model", default="mlx-community/whisper-turbo")
    parser.add_argument("--language", default="")
    parser.add_argument("--result-json", required=True)
    return parser.parse_args()


def is_youtube_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in {"youtube.com", "youtu.be"} or host.endswith(".youtube.com")


def youtube_downloader_command() -> list[str]:
    node = shutil.which("node")
    if not node:
        node = next(
            (str(path) for path in (Path("/usr/local/bin/node"), Path("/opt/homebrew/bin/node")) if path.is_file()),
            None,
        )
    if not node:
        raise RuntimeError("YouTube 音轨解析需要 Node.js；请先安装或配置 Node.js")
    # Run the isolated yt-dlp and its bundled official EJS solver. Do not read
    # the user's yt-dlp configuration or browser cookies implicitly.
    return [
        sys.executable, "-m", "yt_dlp", "--ignore-config",
        "--js-runtimes", f"node:{node}", "--socket-timeout", "30", "--retries", "2",
    ]


def youtube_original_audio_format(metadata: dict) -> str:
    audio = [
        item for item in metadata.get("formats", [])
        if item.get("acodec") not in (None, "none") and item.get("vcodec") == "none"
    ]
    if any("original" in str(item.get("format_note") or "").lower() for item in audio):
        return "bestaudio[format_note*=original]"
    languages = {str(item["language"]) for item in audio if item.get("language")}
    if len(languages) > 1:
        raise RuntimeError("视频包含多种音轨，但无法确认原始音轨；请先提供原声文件")
    return "bestaudio/best"


def main() -> None:
    args = parse_args()
    youtube = is_youtube_url(args.url)
    if args.python_ytdlp and not youtube:
        raise RuntimeError("隔离的 YouTube 下载器仅用于 YouTube 链接")
    downloader = youtube_downloader_command() if args.python_ytdlp else [args.yt_dlp]
    fallback_audio_url = ""
    try:
        metadata_raw = run(
            downloader + [
                "--no-playlist",
                "--no-warnings",
                "--dump-single-json",
                args.url,
            ],
            capture=True,
        )
        metadata = json.loads(metadata_raw)
    except (RuntimeError, json.JSONDecodeError) as error:
        if youtube:
            raise RuntimeError(f"YouTube 视频信息读取失败：{error}") from error
        metadata, fallback_audio_url = bilibili_fallback(args.url)

    with tempfile.TemporaryDirectory(prefix="media-linked-import-") as temp_name:
        temp_dir = Path(temp_name)
        if fallback_audio_url:
            run(
                [
                    "/usr/bin/curl",
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--location",
                    "--max-time",
                    "300",
                    "--user-agent",
                    "Mozilla/5.0",
                    "--referer",
                    args.url,
                    "--output",
                    str(temp_dir / "source.m4s"),
                    fallback_audio_url,
                ]
            )
        else:
            try:
                run(
                    downloader + [
                        "--no-playlist",
                        "--no-progress",
                        "--no-warnings",
                        "-f",
                        youtube_original_audio_format(metadata) if youtube else "bestaudio/best",
                        "-o",
                        str(temp_dir / "source.%(ext)s"),
                        args.url,
                    ]
                )
            except RuntimeError as error:
                if youtube:
                    raise RuntimeError(f"YouTube 原声音轨下载失败：{error}") from error
                metadata, fallback_audio_url = bilibili_fallback(args.url)
                run(
                    [
                        "/usr/bin/curl",
                        "--fail",
                        "--silent",
                        "--show-error",
                        "--location",
                        "--max-time",
                        "300",
                        "--user-agent",
                        "Mozilla/5.0",
                        "--referer",
                        args.url,
                        "--output",
                        str(temp_dir / "source.m4s"),
                        fallback_audio_url,
                    ]
                )
        candidates = [
            item
            for item in temp_dir.glob("source.*")
            if item.is_file() and item.suffix.lower() not in {".part", ".ytdl"}
        ]
        if not candidates:
            raise RuntimeError("yt-dlp did not produce an audio file")
        source_path = max(candidates, key=lambda item: item.stat().st_size)

        wav_path = temp_dir / "audio-16k-mono.wav"
        run(
            [
                imageio_ffmpeg.get_ffmpeg_exe(),
                "-y",
                "-i",
                str(source_path),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                str(wav_path),
            ]
        )

        result = mlx_whisper.transcribe(
            load_pcm_wav(wav_path),
            path_or_hf_repo=args.model,
            language=args.language or None,
            task="transcribe",
            verbose=False,
            condition_on_previous_text=False,
        )

    segments = []
    for item in result.get("segments", []):
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        start = max(0.0, float(item.get("start", 0.0)))
        end = max(start + 0.1, float(item.get("end", start + 1.0)))
        segments.append({"start": start, "end": end, "text": text})

    upload_date = str(metadata.get("upload_date") or "")
    if len(upload_date) == 8 and upload_date.isdigit():
        upload_date = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}"

    payload = {
        "metadata": {
            "videoId": metadata.get("id", ""),
            "title": metadata.get("title", ""),
            "creator": metadata.get("uploader", ""),
            "creatorUrl": metadata.get("uploader_url", ""),
            "description": metadata.get("description", ""),
            "duration": metadata.get("duration") or 0,
            "thumbnailUrl": metadata.get("thumbnail", ""),
            "publishedAt": upload_date,
        },
        "language": result.get("language", args.language or "auto"),
        "text": str(result.get("text", "")).strip(),
        "segments": segments,
    }
    Path(args.result_json).write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
