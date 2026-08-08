#!/usr/bin/env bash
# Native OmniVoice server (Apple Silicon MPS or local CPU/CUDA host).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

export DEVICE="${DEVICE:-mps}"
export PORT="${PORT:-8880}"
export MODEL_ID="${MODEL_ID:-k2-fsa/OmniVoice}"
export HF_HOME="${HF_HOME:-$ROOT/data/models}"
export OMNIVOICE_DATA="${OMNIVOICE_DATA:-$ROOT/data}"
export ADMIN_TOKEN="${ADMIN_TOKEN:-change-me}"
export MPS_FLOAT32="${MPS_FLOAT32:-1}"
export MPS_EAGER_ATTN="${MPS_EAGER_ATTN:-1}"

mkdir -p "$OMNIVOICE_DATA/voices" "$HF_HOME"

VENV="$ROOT/.venv"
if [[ ! -d "$VENV" ]]; then
  echo "Creating venv at $VENV"
  python3 -m venv "$VENV"
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  pip install --upgrade pip
  # Apple Silicon / generic: torch from PyPI
  pip install torch torchaudio
  pip install -e .
else
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
fi

echo "OmniVoice native on DEVICE=$DEVICE port $PORT"
exec python -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
