"""Сборка текстовых промптов для персонажей и фонов."""

from __future__ import annotations

from .config import CharacterShot, Project
from .poses import POSES

GENDER = {"male": "man", "female": "woman"}


def _ap(project: Project, group: str, key) -> str:
    """Ключ из appearance.yaml (по-русски) -> текст промпта; неизвестное отдаём как есть."""
    if not key:
        return ""
    return (project.appearance.get(group) or {}).get(key, key)


def appearance_parts(project: Project, c: dict) -> tuple[str, list[str]]:
    """(возраст, [кожа, телосложение, волосы, борода, особенности])."""
    age = _ap(project, "ages", c.get("age")) or "young adult"
    skin = project.skin_tones.get(c.get("skin"), {}).get("prompt", c.get("skin", ""))
    if c.get("hair_style") or c.get("hair_color"):
        style = _ap(project, "hair_styles", c.get("hair_style"))
        color = _ap(project, "hair_colors", c.get("hair_color"))
        hair = style if style == "bald head" else " ".join(x for x in (color, style) if x)
    else:
        hair = c.get("hair", "")
    beard = _ap(project, "facial_hair", c.get("facial_hair"))
    return age, [skin, _ap(project, "builds", c.get("build")), hair,
                 ("with " + beard) if beard else "", c.get("features", "")]


def character_prompt(project: Project, shot: CharacterShot) -> str:
    c = project.character(shot.char_id)
    gender = GENDER.get(c.get("gender"), c.get("gender", "person"))
    outfit = shot.outfit_dict

    wear = []
    for slot in ("head", "top", "bottom", "shoes"):
        p = project.item(slot, outfit[slot]).get("prompt")
        if p:
            wear.append(p)

    # поза и одежда в начале: FLUX.2 klein 4B теряет детали из конца длинного промпта
    age, looks = appearance_parts(project, c)
    parts = [
        f"full body shot of a single {age} {gender}",
        POSES[shot.pose]["prompt"],
        ("wearing " + ", ".join(wear)) if wear else "",
        *looks,
        "whole figure visible from head to toes, centered",
        "isolated on a plain flat light grey background, no shadows on the background",
        project.settings["style"]["character"],
    ]
    return ", ".join(p for p in parts if p)


def character_negative(project: Project) -> str:
    return project.settings["style"].get("character_negative", "")


def background_prompt(project: Project, location: str, variation: str) -> str:
    loc = project.backgrounds[location]
    var = project.variations[variation]
    return ", ".join([loc["prompt"], var, project.settings["style"]["background"]])


def background_negative(project: Project) -> str:
    return project.settings["style"].get("background_negative", "")
