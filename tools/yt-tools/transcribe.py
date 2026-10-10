import argparse
import json
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np

CHUNK_SECONDS = 15 * 60


def ffmpeg_wav(source, target):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("未找到 ffmpeg")
    subprocess.run(
        [ffmpeg, "-y", "-i", str(source), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(target)],
        check=True,
    )


def read_wav(path):
    with wave.open(str(path), "rb") as handle:
        if handle.getnchannels() != 1 or handle.getframerate() != 16000 or handle.getsampwidth() != 2:
            raise SystemExit("分段音频必须是 16kHz 单声道 16-bit WAV")
        frames = handle.readframes(handle.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def write_wav(path, samples):
    pcm = np.clip(samples, -1, 1)
    ints = (pcm * 32768.0).astype(np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(ints.tobytes())


def stamp(seconds):
    millis = max(0, int(round(float(seconds) * 1000)))
    hours, rem = divmod(millis, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def stamp_txt(seconds):
    return stamp(seconds).replace(",", ".")


def choose_device():
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def transcribe_chunk(model, samples, language):
    kwargs = {"vad_filter": True}
    if language:
        kwargs["language"] = language
    segments, _info = model.transcribe(samples, **kwargs)
    return [{"start": float(item.start), "end": float(item.end), "text": item.text.strip()} for item in segments]


def remove_audio(source, work):
    if work.exists():
        shutil.rmtree(work)
    if source.is_file():
        source.unlink()


def merge(parts, srt_path, txt_path):
    rows = []
    lines = []
    for part in parts:
        offset = part["offset"]
        for item in part["segments"]:
            start = offset + item["start"]
            end = offset + item["end"]
            text = item["text"].strip()
            if not text:
                continue
            rows.append((start, end, text))
            lines.append(f"[{stamp_txt(start)} --> {stamp_txt(end)}] {text}")
    srt = []
    for index, (start, end, text) in enumerate(rows, start=1):
        srt.append(f"{index}\n{stamp(start)} --> {stamp(end)}\n{text}\n")
    srt_path.write_text("\n".join(srt), encoding="utf-8")
    txt_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="把音频按 15 分钟分段转写")
    parser.add_argument("audio")
    parser.add_argument("--model", default="medium")
    parser.add_argument("--lang", default=None)
    args = parser.parse_args()

    source = Path(args.audio).expanduser().resolve()
    if not source.is_file():
        raise SystemExit(f"找不到音频: {source}")
    work = source.parent / f"{source.stem}.parts"
    work.mkdir(parents=True, exist_ok=True)
    wav_path = work / "source.wav"
    if not wav_path.exists():
        ffmpeg_wav(source, wav_path)
    audio = read_wav(wav_path)
    frames = 16000 * CHUNK_SECONDS
    total = max(1, int(np.ceil(len(audio) / frames)))

    device, compute = choose_device()
    from faster_whisper import WhisperModel
    model = None
    saved = []
    for index in range(total):
        part_path = work / f"part-{index:03d}.json"
        offset = index * CHUNK_SECONDS
        if part_path.exists():
            saved.append(json.loads(part_path.read_text(encoding="utf-8")))
            print(f"跳过已完成段落 {index + 1}/{total}")
            continue
        if model is None:
            print(f"加载模型 {args.model} ({device}, {compute})")
            model = WhisperModel(args.model, device=device, compute_type=compute)
        chunk = audio[index * frames:(index + 1) * frames]
        write_wav(work / f"part-{index:03d}.wav", chunk)
        segments = transcribe_chunk(model, chunk, args.lang)
        payload = {"index": index, "offset": offset, "segments": segments}
        part_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        saved.append(payload)
        print(f"完成段落 {index + 1}/{total}，{len(segments)} 句")

    saved.sort(key=lambda item: item["index"])
    srt_path = source.with_suffix(".srt")
    txt_path = source.with_suffix(".txt")
    merge(saved, srt_path, txt_path)
    remove_audio(source, work)
    print(f"SRT: {srt_path}")
    print(f"TXT: {txt_path}")
    print("已删除音频和中间文件")


if __name__ == "__main__":
    main()
