"""Сборка текстовых промптов для персонажей и фонов."""

from __future__ import annotations

from .config import CharacterShot, Project
from .poses import POSES

GENDER = {"male": "man", "female": "woman"}


def character_prompt(project: Project, shot: CharacterShot) -> str:
    c = project.character(shot.char_id)
    skin = project.skin_tones.get(c.get("skin"), {}).get("prompt", c.get("skin", ""))
    gender = GENDER.get(c.get("gender"), c.get("gender", "person"))
    outfit = shot.outfit_dict

    wear = []
    for slot in ("head", "top", "bottom", "shoes"):
        p = project.item(slot, outfit[slot]).get("prompt")
        if p:
            wear.append(p)

    parts = [
        f"full body shot of a single {c.get('age', 'adult')} {gender}",
        skin,
        c.get("hair", ""),
        c.get("features", ""),
        ("wearing " + ", ".join(wear)) if wear else "",
        POSES[shot.pose]["prompt"],
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
