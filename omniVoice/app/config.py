from __future__ import annotations

import os
from pathlib import Path

# Empty HF_ENDPOINT (common compose default) makes huggingface_hub build
# relative URLs with no scheme → httpx UnsupportedProtocol.
for _hf_key in ("HF_ENDPOINT", "HF_HUB_ENDPOINT"):
    if _hf_key in os.environ and not os.environ[_hf_key].strip():
        del os.environ[_hf_key]

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("OMNIVOICE_DATA", str(ROOT / "data")))
VOICES_DIR = DATA_DIR / "voices"
MODELS_DIR = Path(os.environ.get("HF_HOME", str(DATA_DIR / "models")))

DEVICE = os.environ.get("DEVICE", "cpu").strip() or "cpu"
MODEL_ID = os.environ.get("MODEL_ID", "k2-fsa/OmniVoice").strip()
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
PORT = int(os.environ.get("PORT", "8880"))

MPS_FLOAT32 = os.environ.get("MPS_FLOAT32", "1").strip() not in ("0", "false", "False")
MPS_EAGER_ATTN = os.environ.get("MPS_EAGER_ATTN", "1").strip() not in (
    "0",
    "false",
    "False",
)


def ensure_dirs() -> None:
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
