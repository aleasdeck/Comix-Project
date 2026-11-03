"""Генерация ассетов через ComfyUI: персонажи (Flux / Z-Image) и фоны (Qwen-Image)."""

from __future__ import annotations

import json
import zlib
from pathlib import Path

from .comfy import ComfyClient, load_workflow
from .config import ROOT, CharacterShot, Project, background_path
from .cutout import cutout, trim
from .poses import render_openpose
from .prompts import background_negative, background_prompt, character_negative, character_prompt

DRY_DIR = ROOT / "build" / "dry_run"


def _seed(text: str) -> int:
    return zlib.crc32(text.encode()) & 0x7FFFFFFF


def character_job(project: Project, shot: CharacterShot) -> tuple[Path, dict, bool]:
    """Возвращает (шаблон воркфлоу, значения плейсхолдеров, нужна ли поза)."""
    s = project.settings
    engine = s.get("character_engine", "flux")
    m = s["models"][engine]
    w, h = s["sizes"]["character"]
    c = project.character(shot.char_id)
    use_pose = engine == "flux" and s.get("use_pose_controlnet", False)
    wf_key = "flux_pose" if use_pose else engine
    values = {
        "POSITIVE": character_prompt(project, shot),
        "NEGATIVE": character_negative(project),
        # одинаковый сид для персонажа во всех позах и нарядах -> похожее лицо
        "SEED": int(c.get("seed", _seed(shot.char_id))),
        "WIDTH": w, "HEIGHT": h,
        "STEPS": m.get("steps", 20),
        "GUIDANCE": m.get("guidance", 3.5),
        "CFG": m.get("cfg", 1.0),
        "UNET": m.get("unet", ""),
        "CLIP": m.get("clip", ""),
        "CLIP_T5": m.get("clip_t5", ""),
        "CLIP_L": m.get("clip_l", ""),
        "VAE": m.get("vae", ""),
        "CONTROLNET": m.get("controlnet", ""),
        "PREFIX": f"comix/characters/{shot.char_id}_{shot.pose}",
        "POSE_IMAGE": f"comix_pose_{shot.pose}.png",
    }
    return ROOT / s["workflows"][wf_key], values, use_pose


def background_job(project: Project, location: str, variation: str, seed_offset: int = 0) -> tuple[Path, dict]:
    s = project.settings
    m = s["models"]["qwen"]
    w, h = s["sizes"]["background"]
    values = {
        "POSITIVE": background_prompt(project, location, variation),
        "NEGATIVE": background_negative(project),
        "SEED": _seed(f"{location}/{variation}") + seed_offset,
        "WIDTH": w, "HEIGHT": h,
        "STEPS": m.get("steps", 20),
        "CFG": m.get("cfg", 2.5),
        "UNET": m["unet"], "CLIP": m["clip"], "VAE": m["vae"],
        "PREFIX": f"comix/backgrounds/{location}_{variation}",
    }
    return ROOT / s["workflows"]["qwen"], values


def _dry(name: str, wf_path: Path, values: dict) -> Path:
    DRY_DIR.mkdir(parents=True, exist_ok=True)
    wf = load_workflow(wf_path, values)
    out = DRY_DIR / f"{name}.json"
    out.write_text(json.dumps(wf, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def generate_character(project: Project, shot: CharacterShot, client: ComfyClient | None,
                       force: bool = False) -> Path | None:
    """client=None -> сухой прогон: только собрать воркфлоу в build/dry_run."""
    if shot.path.exists() and not force:
        return shot.path
    wf_path, values, use_pose = character_job(project, shot)
    name = f"char_{shot.char_id}_{shot.outfit_key}_{shot.pose}"
    if client is None:
        return _dry(name, wf_path, values)
    if use_pose:
        size = tuple(project.settings["sizes"]["character"])
        values["POSE_IMAGE"] = client.upload_image(render_openpose(shot.pose, size), values["POSE_IMAGE"])
    img = client.run(load_workflow(wf_path, values))[0]
    raw = shot.path.with_name(shot.pose + "_raw.png")
    raw.parent.mkdir(parents=True, exist_ok=True)
    img.save(raw)
    cfg = project.settings.get("cutout", {})
    trim(cutout(img, cfg.get("method", "auto"), cfg.get("tolerance", 28))).save(shot.path)
    return shot.path


def generate_background(project: Project, location: str, variation: str, client: ComfyClient | None,
                        force: bool = False) -> Path | None:
    out = background_path(location, variation)
    if out.exists() and not force:
        return out
    wf_path, values = background_job(project, location, variation)
    if client is None:
        return _dry(f"bg_{location}_{variation}", wf_path, values)
    img = client.run(load_workflow(wf_path, values))[0]
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    return out
