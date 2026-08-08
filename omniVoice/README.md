# OmniVoice local TTS service (k2-fsa/OmniVoice)

OpenAI-compatible speech API with OmniVoice design presets for One Night AI Werewolf.

## Run modes

### Apple Silicon (this Mac) — native MPS

```bash
cd omniVoice
cp -n .env.example .env   # edit ADMIN_TOKEN if desired
make -C .. omnivoice-native
# or: ./run-native.sh
```

Admin UI: http://127.0.0.1:8880/admin  
Health: http://127.0.0.1:8880/health

### NVIDIA Spark / DGX — CUDA Docker

DGX Spark (GB10, `sm_121`) needs **CUDA 13** wheels (`cu130`). The image is
`nvidia/cuda:13.0.1-runtime-ubuntu24.04` + PyTorch `+cu130` — not CUDA 12.

```bash
cd omniVoice
cp -n .env.example .env
# set DEVICE=cuda:0 and ADMIN_TOKEN=... in omniVoice/.env (not the repo-root .env)
make -C .. omnivoice-docker
```

Requires NVIDIA Container Toolkit and a CUDA 13-capable driver.

Compose only reads **`omniVoice/.env`** for `ADMIN_TOKEN` / `HF_TOKEN` / etc. After editing
that file, recreate so the container picks up new values:

```bash
cd omniVoice && docker compose up -d
```

## API

| Method | Path | Notes |
|--------|------|--------|
| GET | `/health` | Device + model status |
| GET | `/v1/models` | `omnivoice` |
| POST | `/v1/audio/speech` | OpenAI-shaped body; `voice` = saved voice id or `auto` |
| GET | `/v1/voices` | List cloned voices |
| POST | `/v1/voices` | Multipart: `name`, `createdBy`, `file`, optional `ref_text` |
| DELETE | `/v1/voices/{id}` | Creator (`X-Creator-Id`) or admin (`X-Admin-Token`) |
| GET | `/admin` | Admin UI |

First startup downloads ~4GB model weights into `data/models` (or the Docker volume).
