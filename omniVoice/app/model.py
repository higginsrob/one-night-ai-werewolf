from __future__ import annotations

import io
import threading
from typing import Any

import numpy as np
import soundfile as sf

from . import config

_lock = threading.Lock()
_model: Any | None = None
_load_error: str | None = None


def get_load_error() -> str | None:
    return _load_error


def is_loaded() -> bool:
    return _model is not None


def get_model() -> Any:
    global _model, _load_error
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        try:
            import torch
            from omnivoice import OmniVoice

            kwargs: dict[str, Any] = {
                "device_map": config.DEVICE,
            }
            device = config.DEVICE.lower()
            if device.startswith("mps"):
                if config.MPS_FLOAT32:
                    kwargs["dtype"] = torch.float32
                if config.MPS_EAGER_ATTN:
                    kwargs["attn_implementation"] = "eager"
            elif device.startswith("cuda"):
                kwargs["dtype"] = torch.float16
            else:
                kwargs["dtype"] = torch.float32

            _model = OmniVoice.from_pretrained(config.MODEL_ID, **kwargs)
            _load_error = None
            return _model
        except Exception as e:  # noqa: BLE001 — surface to health/API
            _load_error = str(e)
            raise


def unload_model() -> None:
    global _model
    with _lock:
        _model = None


def audio_to_wav_bytes(audio: np.ndarray, sample_rate: int = 24000) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV")
    return buf.getvalue()


def generate_speech(
    text: str,
    *,
    voice_clone_prompt: Any | None = None,
    ref_audio: str | None = None,
    ref_text: str | None = None,
    instruct: str | None = None,
    speed: float = 1.0,
) -> bytes:
    model = get_model()
    kwargs: dict[str, Any] = {"text": text, "speed": speed}
    if voice_clone_prompt is not None:
        kwargs["voice_clone_prompt"] = voice_clone_prompt
    elif ref_audio:
        kwargs["ref_audio"] = ref_audio
        if ref_text:
            kwargs["ref_text"] = ref_text
        # Optional style steering; model prefers the reference on conflict.
        if instruct:
            kwargs["instruct"] = instruct
    elif instruct:
        kwargs["instruct"] = instruct

    audio_list = model.generate(**kwargs)
    audio = audio_list[0]
    if not isinstance(audio, np.ndarray):
        audio = np.asarray(audio, dtype=np.float32)
    return audio_to_wav_bytes(audio)


def create_clone_prompt(ref_audio: str, ref_text: str | None = None) -> Any:
    model = get_model()
    kwargs: dict[str, Any] = {"ref_audio": ref_audio}
    if ref_text:
        kwargs["ref_text"] = ref_text
    return model.create_voice_clone_prompt(**kwargs)
