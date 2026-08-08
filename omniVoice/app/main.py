from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config
from . import model as model_mod
from . import presets as presets_mod
from . import voices as voices_mod

ADMIN_DIR = Path(__file__).resolve().parent / "admin_static"


class SpeechRequest(BaseModel):
    model: str = "omnivoice"
    input: str = Field(..., min_length=1)
    voice: str = "auto"
    response_format: Literal["wav", "mp3"] = "wav"
    speed: float = 1.0
    # OmniVoice extensions (ignored by strict OpenAI clients)
    instruct: str | None = None
    # Prior chunk audio (base64 WAV/MP3) to lock timbre across sentence chunks.
    ref_audio_b64: str | None = None
    ref_text: str | None = None


def create_app() -> FastAPI:
    config.ensure_dirs()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        import threading

        def warm() -> None:
            try:
                model_mod.get_model()
            except Exception:
                pass

        threading.Thread(target=warm, daemon=True).start()
        yield

    app = FastAPI(title="OmniVoice TTS", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    if ADMIN_DIR.is_dir():
        app.mount(
            "/admin/static",
            StaticFiles(directory=str(ADMIN_DIR)),
            name="admin-static",
        )

    @app.get("/", response_class=HTMLResponse)
    def root() -> HTMLResponse:
        return HTMLResponse(
            """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OmniVoice TTS</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto;
           padding: 0 1rem; line-height: 1.5; }
    code { background: #f0f0f0; padding: 0.1em 0.35em; border-radius: 4px; }
    a { color: #1a5fb4; }
  </style>
</head>
<body>
  <h1>OmniVoice TTS</h1>
  <p>Service is running. Useful links:</p>
  <ul>
    <li><a href="/admin">Admin</a> — manage cloned voices</li>
    <li><a href="/health">Health</a> — JSON status</li>
    <li><a href="/docs">API docs</a> — Swagger UI</li>
    <li><code>POST /v1/audio/speech</code> — OpenAI-compatible TTS</li>
    <li><code>GET /v1/voices</code> — list cloned voices</li>
  </ul>
</body>
</html>"""
        )

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "ok": True,
            "device": config.DEVICE,
            "modelId": config.MODEL_ID,
            "modelLoaded": model_mod.is_loaded(),
            "loadError": model_mod.get_load_error(),
            "voiceCount": len(voices_mod.list_voices()),
        }

    @app.get("/v1/models")
    def list_models() -> dict[str, Any]:
        return {
            "object": "list",
            "data": [
                {
                    "id": "omnivoice",
                    "object": "model",
                    "owned_by": "k2-fsa",
                }
            ],
        }

    @app.post("/v1/audio/speech")
    def audio_speech(body: SpeechRequest) -> Response:
        import base64
        import tempfile

        text = body.input.strip()
        if not text:
            raise HTTPException(status_code=400, detail="input is required")

        voice = (body.voice or "auto").strip()
        instruct = (body.instruct or "").strip() or None
        prompt = None
        ref_audio_path: str | None = None
        ref_text = (body.ref_text or "").strip() or None
        tmp_ref: tempfile.NamedTemporaryFile | None = None

        # Continuity ref wins over design presets so multi-chunk replies keep
        # the same timbre (OmniVoice voice-design drifts per generate call).
        if body.ref_audio_b64 and body.ref_audio_b64.strip():
            try:
                raw = base64.b64decode(body.ref_audio_b64.strip(), validate=False)
            except Exception as e:  # noqa: BLE001
                raise HTTPException(
                    status_code=400, detail=f"invalid ref_audio_b64: {e}"
                ) from e
            if not raw:
                raise HTTPException(status_code=400, detail="empty ref_audio_b64")
            if len(raw) > 12 * 1024 * 1024:
                raise HTTPException(status_code=400, detail="ref_audio too large")
            tmp_ref = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            tmp_ref.write(raw)
            tmp_ref.flush()
            tmp_ref.close()
            ref_audio_path = tmp_ref.name
            # Still resolve preset instruct for gentle style steering with clone.
            if voice and voice != "auto":
                preset = presets_mod.get_preset(voice)
                if preset is not None and not instruct:
                    instruct = preset.instruct
        elif voice and voice != "auto":
            preset = presets_mod.get_preset(voice)
            if preset is not None:
                if not instruct:
                    instruct = preset.instruct
            else:
                meta = voices_mod.get_voice(voice)
                if meta is None:
                    raise HTTPException(
                        status_code=404, detail=f"voice not found: {voice}"
                    )
                prompt = voices_mod.load_prompt(voice)
                if prompt is None:
                    raise HTTPException(
                        status_code=500, detail="voice prompt missing"
                    )

        try:
            wav = model_mod.generate_speech(
                text,
                voice_clone_prompt=prompt,
                ref_audio=ref_audio_path,
                ref_text=ref_text if ref_audio_path else None,
                instruct=instruct if prompt is None else None,
                speed=body.speed,
            )
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=str(e)) from e
        finally:
            if ref_audio_path:
                try:
                    Path(ref_audio_path).unlink(missing_ok=True)
                except OSError:
                    pass

        return Response(content=wav, media_type="audio/wav")

    @app.get("/v1/voices")
    def list_voices() -> dict[str, Any]:
        clones = [
            {**v.__dict__, "kind": "clone"} for v in voices_mod.list_voices()
        ]
        return {
            "object": "list",
            "data": clones,
            "presets": presets_mod.list_presets(),
        }

    @app.post("/v1/voices")
    async def create_voice(
        name: str = Form(...),
        createdBy: str = Form(...),
        ref_text: str | None = Form(None),
        file: UploadFile = File(...),
    ) -> dict[str, Any]:
        raw = await file.read()
        if not raw:
            raise HTTPException(status_code=400, detail="empty audio file")
        if len(raw) > 12 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="audio too large (max 12MB)")
        try:
            meta = voices_mod.create_voice(
                name=name,
                created_by=createdBy,
                ref_audio_bytes=raw,
                ref_filename=file.filename or "ref.wav",
                ref_text=(ref_text or "").strip() or None,
            )
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=str(e)) from e
        return meta.__dict__

    def _voice_write_allowed(
        meta: voices_mod.VoiceMeta,
        x_creator_id: str | None,
        x_admin_token: str | None,
    ) -> bool:
        admin_ok = bool(
            config.ADMIN_TOKEN
            and x_admin_token
            and x_admin_token.strip() == config.ADMIN_TOKEN
        )
        creator_ok = bool(
            x_creator_id and x_creator_id.strip() == meta.createdBy
        )
        return admin_ok or creator_ok

    @app.put("/v1/voices/{voice_id}")
    async def update_voice(
        voice_id: str,
        name: str | None = Form(None),
        ref_text: str | None = Form(None),
        file: UploadFile | None = File(None),
        x_creator_id: str | None = Header(default=None, alias="X-Creator-Id"),
        x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
    ) -> dict[str, Any]:
        meta = voices_mod.get_voice(voice_id)
        if meta is None:
            raise HTTPException(status_code=404, detail="voice not found")
        if not _voice_write_allowed(meta, x_creator_id, x_admin_token):
            raise HTTPException(
                status_code=403, detail="not allowed to update this voice"
            )

        raw: bytes | None = None
        filename: str | None = None
        if file is not None:
            raw = await file.read()
            if not raw:
                raise HTTPException(status_code=400, detail="empty audio file")
            if len(raw) > 12 * 1024 * 1024:
                raise HTTPException(
                    status_code=400, detail="audio too large (max 12MB)"
                )
            filename = file.filename or "ref.wav"

        if raw is None and (name is None or not name.strip()):
            raise HTTPException(
                status_code=400, detail="name or file required"
            )

        try:
            updated = voices_mod.update_voice(
                voice_id=voice_id,
                name=name,
                ref_audio_bytes=raw,
                ref_filename=filename,
                ref_text=(ref_text or "").strip() or None,
            )
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=str(e)) from e
        return updated.__dict__

    @app.delete("/v1/voices/{voice_id}")
    def delete_voice(
        voice_id: str,
        x_creator_id: str | None = Header(default=None, alias="X-Creator-Id"),
        x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
    ) -> dict[str, Any]:
        meta = voices_mod.get_voice(voice_id)
        if meta is None:
            raise HTTPException(status_code=404, detail="voice not found")

        if not _voice_write_allowed(meta, x_creator_id, x_admin_token):
            raise HTTPException(
                status_code=403, detail="not allowed to delete this voice"
            )

        voices_mod.delete_voice(voice_id)
        return {"ok": True, "id": voice_id}

    @app.post("/admin/api/clear-voices")
    def admin_clear_voices(
        x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
    ) -> dict[str, Any]:
        if (
            not config.ADMIN_TOKEN
            or not x_admin_token
            or x_admin_token.strip() != config.ADMIN_TOKEN
        ):
            raise HTTPException(status_code=403, detail="admin token required")
        n = voices_mod.clear_all_voices()
        return {"ok": True, "deleted": n}

    @app.post("/admin/api/unload-model")
    def admin_unload_model(
        x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
    ) -> dict[str, Any]:
        if (
            not config.ADMIN_TOKEN
            or not x_admin_token
            or x_admin_token.strip() != config.ADMIN_TOKEN
        ):
            raise HTTPException(status_code=403, detail="admin token required")
        model_mod.unload_model()
        return {"ok": True}

    @app.get("/admin", response_class=HTMLResponse)
    def admin_page() -> HTMLResponse:
        index = ADMIN_DIR / "index.html"
        if not index.exists():
            raise HTTPException(status_code=404, detail="admin UI missing")
        return HTMLResponse(index.read_text(encoding="utf-8"))

    return app


app = create_app()
