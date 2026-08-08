"""Built-in OmniVoice voice-design presets (instruct strings)."""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class DesignPreset:
    id: str
    name: str
    instruct: str
    kind: str = "design"
    createdBy: str = "omnivoice"
    createdAt: str = ""


# OpenAI-style ids mapped to OmniVoice voice-design attributes.
DESIGN_PRESETS: tuple[DesignPreset, ...] = (
    DesignPreset(
        "alloy",
        "Alloy",
        "female, young adult, moderate pitch, american accent",
    ),
    DesignPreset(
        "ash",
        "Ash",
        "male, young adult, low pitch, american accent",
    ),
    DesignPreset(
        "ballad",
        "Ballad",
        "male, middle-aged, low pitch, british accent",
    ),
    DesignPreset(
        "coral",
        "Coral",
        "female, young adult, high pitch, australian accent",
    ),
    DesignPreset(
        "echo",
        "Echo",
        "male, middle-aged, moderate pitch, canadian accent",
    ),
    DesignPreset(
        "fable",
        "Fable",
        "female, middle-aged, moderate pitch, british accent",
    ),
    DesignPreset(
        "nova",
        "Nova",
        "female, young adult, high pitch, american accent",
    ),
    DesignPreset(
        "onyx",
        "Onyx",
        "male, middle-aged, very low pitch, british accent",
    ),
    DesignPreset(
        "sage",
        "Sage",
        "female, elderly, low pitch, british accent",
    ),
    DesignPreset(
        "shimmer",
        "Shimmer",
        "female, young adult, very high pitch, american accent",
    ),
    DesignPreset(
        "narrator_warm",
        "Narrator (warm)",
        "male, middle-aged, moderate pitch, american accent",
    ),
    DesignPreset(
        "narrator_crisp",
        "Narrator (crisp)",
        "female, middle-aged, moderate pitch, british accent",
    ),
)

PRESET_BY_ID = {p.id: p for p in DESIGN_PRESETS}
PRESET_BY_ID_CI = {p.id.lower(): p for p in DESIGN_PRESETS}
PRESET_BY_NAME_CI = {p.name.lower(): p for p in DESIGN_PRESETS}


def list_presets() -> list[dict]:
    return [asdict(p) for p in DESIGN_PRESETS]


def get_preset(voice_id: str) -> DesignPreset | None:
    key = voice_id.strip()
    if not key:
        return None
    return (
        PRESET_BY_ID.get(key)
        or PRESET_BY_ID_CI.get(key.lower())
        or PRESET_BY_NAME_CI.get(key.lower())
    )
