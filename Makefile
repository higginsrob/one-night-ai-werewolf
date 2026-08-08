.PHONY: help dev build preview lint skills skills-user skills-clean \
	omnivoice-native omnivoice-docker omnivoice-up omnivoice-down omnivoice-logs

.DEFAULT_GOAL := help

SKILLS_SRC := .cursor/skills
SKILL_NAMES := one-night-ai-werewolf
OMNIVOICE_DIR := omniVoice
UNAME_S := $(shell uname -s)

USER_CURSOR := $(HOME)/.cursor/skills

define sync_skills_to
	@test -d "$(SKILLS_SRC)" || (echo "Missing $(SKILLS_SRC)/"; exit 1)
	@mkdir -p "$(1)"
	@for skill in $(SKILL_NAMES); do \
		src="$(SKILLS_SRC)/$$skill"; \
		if [ ! -d "$$src" ]; then \
			echo "skip missing $$src"; \
			continue; \
		fi; \
		mkdir -p "$(1)/$$skill"; \
		rsync -a --delete "$$src/" "$(1)/$$skill/"; \
		echo "  $$skill → $(1)/$$skill/"; \
	done
	@echo "Synced skills → $(1)"
endef

help:
	@echo ""
	@echo "  One Night AI Werewolf — make targets"
	@echo "  ──────────────────────────────────────────────────"
	@echo "  make dev           Vite dev server (bun run dev)"
	@echo "  make build         Production build"
	@echo "  make preview       Preview production build"
	@echo "  make lint          oxlint"
	@echo "  make skills        Sync Cursor skills into ~/.cursor/skills"
	@echo "  make skills-clean  Remove synced skills from ~/.cursor/skills"
	@echo ""
	@echo "  OmniVoice TTS"
	@echo "  ──────────────────────────────────────────────────"
	@echo "  make omnivoice-native  Native server (MPS on Darwin)"
	@echo "  make omnivoice-docker  CUDA Docker (NVIDIA Spark/DGX)"
	@echo "  make omnivoice-up      Darwin → native; else docker"
	@echo "  make omnivoice-down    Stop docker compose"
	@echo "  make omnivoice-logs    Docker logs (or native hint)"
	@echo ""

dev:
	bun run dev

build:
	bun run build

preview:
	bun run preview

lint:
	bun run lint

skills:
	$(call sync_skills_to,$(USER_CURSOR))

skills-user: skills

skills-clean:
	@for skill in $(SKILL_NAMES); do \
		rm -rf "$(USER_CURSOR)/$$skill"; \
	done
	@echo "Removed One Night AI Werewolf skills from $(USER_CURSOR)"

omnivoice-native:
	@cd $(OMNIVOICE_DIR) && ./run-native.sh

omnivoice-docker:
	@cd $(OMNIVOICE_DIR) && docker compose up --build -d

omnivoice-up:
ifeq ($(UNAME_S),Darwin)
	@$(MAKE) omnivoice-native
else
	@$(MAKE) omnivoice-docker
endif

omnivoice-down:
	@cd $(OMNIVOICE_DIR) && docker compose down || true
	@echo "Docker OmniVoice stopped (if it was running)."
	@echo "Native: stop the foreground ./run-native.sh / make omnivoice-native process (Ctrl+C)."

omnivoice-logs:
ifeq ($(UNAME_S),Darwin)
	@echo "Native OmniVoice logs are in the terminal running make omnivoice-native."
	@echo "Admin: http://127.0.0.1:8880/admin"
else
	@cd $(OMNIVOICE_DIR) && docker compose logs -f
endif
