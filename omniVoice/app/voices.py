from __future__ import annotations

import json
import shutil
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config
from . import model as model_mod


@dataclass
class VoiceMeta:
    id: str
    name: str
    createdBy: str
    createdAt: str


def _voice_dir(voice_id: str) -> Path:
    return config.VOICES_DIR / voice_id


def _meta_path(voice_id: str) -> Path:
    return _voice_dir(voice_id) / "meta.json"


def _prompt_path(voice_id: str) -> Path:
    return _voice_dir(voice_id) / "prompt.pt"


def _ref_path(voice_id: str, suffix: str = ".wav") -> Path:
    return _voice_dir(voice_id) / f"ref{suffix}"


def list_voices() -> list[VoiceMeta]:
    config.ensure_dirs()
    out: list[VoiceMeta] = []
    if not config.VOICES_DIR.exists():
        return out
    for child in sorted(config.VOICES_DIR.iterdir()):
        if not child.is_dir():
            continue
        meta_file = child / "meta.json"
        if not meta_file.exists():
            continue
        try:
            raw = json.loads(meta_file.read_text(encoding="utf-8"))
            out.append(
                VoiceMeta(
                    id=str(raw["id"]),
                    name=str(raw["name"]),
                    createdBy=str(raw.get("createdBy", "")),
                    createdAt=str(raw.get("createdAt", "")),
                )
            )
        except (OSError, KeyError, TypeError, json.JSONDecodeError):
            continue
    return out


def get_voice(voice_id: str) -> VoiceMeta | None:
    path = _meta_path(voice_id)
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return VoiceMeta(
            id=str(raw["id"]),
            name=str(raw["name"]),
            createdBy=str(raw.get("createdBy", "")),
            createdAt=str(raw.get("createdAt", "")),
        )
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return None


def load_prompt(voice_id: str) -> Any | None:
    path = _prompt_path(voice_id)
    if not path.exists():
        return None
    from omnivoice import VoiceClonePrompt

    return VoiceClonePrompt.load(str(path))


def create_voice(
    *,
    name: str,
    created_by: str,
    ref_audio_bytes: bytes,
    ref_filename: str,
    ref_text: str | None = None,
) -> VoiceMeta:
    config.ensure_dirs()
    voice_id = f"v_{uuid.uuid4().hex[:12]}"
    directory = _voice_dir(voice_id)
    directory.mkdir(parents=True, exist_ok=False)

    suffix = Path(ref_filename).suffix.lower() or ".wav"
    if suffix not in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".webm"):
        suffix = ".wav"
    ref_path = _ref_path(voice_id, suffix)
    ref_path.write_bytes(ref_audio_bytes)

    try:
        prompt = model_mod.create_clone_prompt(str(ref_path), ref_text)
        prompt.save(str(_prompt_path(voice_id)))
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise

    meta = VoiceMeta(
        id=voice_id,
        name=name.strip()[:80] or voice_id,
        createdBy=created_by.strip()[:120] or "unknown",
        createdAt=datetime.now(timezone.utc).isoformat(),
    )
    _meta_path(voice_id).write_text(
        json.dumps(asdict(meta), indent=2), encoding="utf-8"
    )
    return meta


def update_voice(
    *,
    voice_id: str,
    name: str | None = None,
    ref_audio_bytes: bytes | None = None,
    ref_filename: str | None = None,
    ref_text: str | None = None,
) -> VoiceMeta:
    meta = get_voice(voice_id)
    if meta is None:
        raise KeyError(f"voice not found: {voice_id}")

    directory = _voice_dir(voice_id)
    if ref_audio_bytes is not None:
        if not ref_audio_bytes:
            raise ValueError("empty audio file")
        suffix = Path(ref_filename or "ref.wav").suffix.lower() or ".wav"
        if suffix not in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".webm"):
            suffix = ".wav"
        # Remove previous ref files so only the new sample remains.
        for old in directory.glob("ref.*"):
            old.unlink(missing_ok=True)
        ref_path = _ref_path(voice_id, suffix)
        ref_path.write_bytes(ref_audio_bytes)
        try:
            prompt = model_mod.create_clone_prompt(str(ref_path), ref_text)
            prompt.save(str(_prompt_path(voice_id)))
        except Exception:
            raise

    next_name = (name.strip()[:80] if name and name.strip() else meta.name)
    updated = VoiceMeta(
        id=meta.id,
        name=next_name,
        createdBy=meta.createdBy,
        createdAt=meta.createdAt,
    )
    _meta_path(voice_id).write_text(
        json.dumps(asdict(updated), indent=2), encoding="utf-8"
    )
    return updated


def delete_voice(voice_id: str) -> bool:
    directory = _voice_dir(voice_id)
    if not directory.exists():
        return False
    shutil.rmtree(directory, ignore_errors=True)
    return True


def clear_all_voices() -> int:
    voices = list_voices()
    n = 0
    for v in voices:
        if delete_voice(v.id):
            n += 1
    return n
