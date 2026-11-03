"""Загрузка конфигов и общие пути."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"
ASSETS = ROOT / "assets"

SLOTS = ("head", "top", "bottom", "shoes")


def load_yaml(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def save_yaml(path: Path, data: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False)


@dataclass
class Project:
    settings: dict
    wardrobe: dict
    characters: dict
    skin_tones: dict
    backgrounds: dict
    variations: dict

    @classmethod
    def load(cls) -> "Project":
        chars = load_yaml(CONFIG / "characters.yaml")
        bgs = load_yaml(CONFIG / "backgrounds.yaml")
        return cls(
            settings=load_yaml(CONFIG / "settings.yaml"),
            wardrobe=load_yaml(CONFIG / "wardrobe.yaml"),
            characters=chars.get("characters", {}) or {},
            skin_tones=chars.get("skin_tones", {}) or {},
            backgrounds=bgs.get("locations", {}) or {},
            variations=bgs.get("variations", {}) or {},
        )

    # --- персонажи и одежда -------------------------------------------------

    def character(self, char_id: str) -> dict:
        if char_id not in self.characters:
            raise KeyError(f"Нет персонажа '{char_id}' в config/characters.yaml")
        return self.characters[char_id]

    def resolve_outfit(self, char_id: str, override: dict | None = None) -> dict:
        """Наряд персонажа с заменой отдельных слотов из сценария."""
        outfit = {s: "none" for s in SLOTS}
        outfit.update(self.character(char_id).get("outfit", {}) or {})
        outfit.update(override or {})
        for slot in SLOTS:
            item = outfit.get(slot) or "none"
            if item not in (self.wardrobe.get(slot) or {}):
                if item == "none":
                    outfit[slot] = "none"
                    continue
                raise KeyError(f"Нет предмета '{item}' в слоте '{slot}' (config/wardrobe.yaml)")
            outfit[slot] = item
        return {s: outfit[s] for s in SLOTS}

    def item(self, slot: str, item_id: str) -> dict:
        return (self.wardrobe.get(slot) or {}).get(item_id) or {"prompt": "", "color": None}


@dataclass(frozen=True)
class CharacterShot:
    """Конкретная картинка персонажа: кто, в чём, в какой позе."""

    char_id: str
    outfit: tuple = field(default=())  # ((slot, item), ...)
    pose: str = "idle"

    @property
    def outfit_dict(self) -> dict:
        return dict(self.outfit)

    @property
    def outfit_key(self) -> str:
        d = self.outfit_dict
        readable = "-".join(d[s] for s in SLOTS)
        return readable if len(readable) <= 80 else hashlib.md5(readable.encode()).hexdigest()[:12]

    @property
    def path(self) -> Path:
        return ASSETS / "characters" / self.char_id / self.outfit_key / f"{self.pose}.png"


def make_shot(project: Project, char_id: str, pose: str, override: dict | None = None) -> CharacterShot:
    outfit = project.resolve_outfit(char_id, override)
    return CharacterShot(char_id, tuple((s, outfit[s]) for s in SLOTS), pose)


def background_path(location: str, variation: str) -> Path:
    return ASSETS / "backgrounds" / location / f"{variation}.png"
