---
name: one-night-ai-werewolf
description: >
  Run, deploy, and troubleshoot the One Night AI Werewolf single-player app
  (Vite + React Three Fiber + local AI opponents). Use when working in this repo.
---

# One Night AI Werewolf

Local one-human-vs-AI session: host-authoritative in-memory reducer, 3D night
lobby, Werewolf deck/settings start. No PeerJS / multiplayer rooms.

## Commands

```bash
bun install
bun run dev
bun run build
bun run lint
make omnivoice-native   # Apple Silicon MPS OmniVoice server
make omnivoice-docker   # NVIDIA CUDA OmniVoice (compose)
make omnivoice-up       # Darwin → native; else docker
```

Dev server listens on `0.0.0.0` (HTTP). Provider base URLs are full URLs
(e.g. `http://127.0.0.1:11434` for Ollama, `http://127.0.0.1:30000/v1` for
SGLang, `http://127.0.0.1:8880/v1` for OmniVoice) — there is no Vite proxy.

## Layout

- `src/net/` — local session hook, AI drivers, protocol types, photo IO
- `src/session/` — authoritative reducer (`SessionSnapshot` + intents)
- `src/game/` — Werewolf logic, scene, HUD, TTS (`browserTts`, `tts` facade, `ttsStore`)
- `src/scene/` — night world, lobby table, player cards
- `src/ui/` — lobby menu, settings (incl. **TTS** panel), overlays
- `src/ai/` — providers, model configs (chat / classifier / guide), personas
- `src/eval/` — DEV-only local benchmark site (`/benchmark.html`), runner, scoring
- `benchmarks/` — gitignored local suite logs (`onw-bench-*.json`); written by the Vite DEV API
- `omniVoice/` — local OmniVoice FastAPI (`/v1/audio/speech`, design presets, `/admin`)

## Rules of the session

- Boots straight into the lobby with one human from the saved local profile (Settings → You: name, nickname, title, persona, photo)
- NPCs are lobby bots from Settings → AI players (six stock defaults; add/edit/delete personas; seat a subset; Reset to defaults restores the stock six)
- **Guided import** uses the guide agent model to interview and fill AI persona fields (name, nickname, title, persona); **AI Interview** on Settings → You uses the same flow for the human profile
- AI agent prompts include a shared **table players** bios block (human + other seated AIs) separate from each seat’s own speaking persona
- **TTS**: Settings → AI providers (add OmniVoice or OpenAI-compatible) + model configs → Settings → TTS picks engine and the active speech model config. OmniVoice uses design presets (age/gender/accent); no in-app voice cloning.
- **Ollama**: Settings → AI providers → Ollama, default `http://127.0.0.1:11434`. Model configs expose num_ctx, keep_alive, top_p, and top_k.
- **SGLang**: Settings → AI providers → SGLang (local), default `http://127.0.0.1:30000/v1`. Model configs expose top_k / min_p / repetition_penalty and thinking (`chat_template_kwargs`). JSON-object response format is a classifier-only option on the active classifier config.
- **Start game** when the lobby deck matches you + AIs; **Watch game** (lobby bar or Settings → Game) when ≥3 AIs are seated — you spectate while day chat runs itself. On Watch click the narrator immediately says “Welcome to One Night AI Werewolf.” Spectators see card backs through claiming, seating, and live night. At dawn the narrator says “Everyone, close your eyes,” then the table flips to dealt night-start roles (locked seat tokens mark those deals) and a narrated ordered night-action replay runs before day discussion (live player night wake/close lines are muted).
- **Benchmark** (DEV only, not in production builds): open `/benchmark.html` (or `/?eval=true`, which redirects). Configure workers, AI cast, role cards, and timers on the site; **Run benchmarks** writes logs into `benchmarks/` automatically and refreshes results. Settings chrome is not used on the benchmark page — configure providers/personas in the main app first.
