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


# --- пачки: выбор бэкенда ----------------------------------------------------

def _finish_character(project: Project, shot: CharacterShot, raw_png: Path):
    from PIL import Image

    img = Image.open(raw_png).convert("RGB")
    shot.path.parent.mkdir(parents=True, exist_ok=True)
    img.save(shot.path.with_name(shot.pose + "_raw.png"))
    cfg = project.settings.get("cutout", {})
    trim(cutout(img, cfg.get("method", "auto"), cfg.get("tolerance", 28))).save(shot.path)


def generate_characters(project: Project, shots: list[CharacterShot], dry: bool, force: bool = False) -> list[Path]:
    todo = [s for s in shots if force or not s.path.exists()]
    if not todo:
        return []
    s = project.settings
    if s.get("backend", "imagegen") != "imagegen":
        client = None if dry else _comfy_client(project)
        return [generate_character(project, sh, client, force) for sh in todo]

    from . import imagegen_backend as ig

    c = s["imagegen"]
    tasks, by_key = [], {}
    for sh in todo:
        key = f"{sh.char_id}__{sh.outfit_key}__{sh.pose}"
        ch = project.character(sh.char_id)
        tasks.append({"key": key, "prompt": character_prompt(project, sh), "negative": character_negative(project),
                      "seed": int(ch.get("seed", _seed(sh.char_id))), "size": c.get("character_size", "portrait")})
        by_key[key] = sh
    raw = ig.run_batch(s, c.get("character_model", "klein"), "characters", tasks, dry)
    done = []
    for key, f in raw.items():
        _finish_character(project, by_key[key], f)
        done.append(by_key[key].path)
    return done


def generate_backgrounds(project: Project, bgs: list[tuple[str, str]], dry: bool, force: bool = False) -> list[Path]:
    todo = [b for b in bgs if force or not background_path(*b).exists()]
    if not todo:
        return []
    s = project.settings
    if s.get("backend", "imagegen") != "imagegen":
        client = None if dry else _comfy_client(project)
        return [generate_background(project, loc, var, client, force) for loc, var in todo]

    from . import imagegen_backend as ig

    c = s["imagegen"]
    tasks = [{"key": f"{loc}__{var}", "prompt": background_prompt(project, loc, var),
              "negative": background_negative(project), "seed": _seed(f"{loc}/{var}"),
              "size": c.get("background_size", "wide")} for loc, var in todo]
    raw = ig.run_batch(s, c.get("background_model", "qwen"), "backgrounds", tasks, dry)
    done = []
    for key, f in raw.items():
        loc, var = key.split("__")
        ig.copy(f, background_path(loc, var))
        done.append(background_path(loc, var))
    return done


def _comfy_client(project: Project) -> ComfyClient:
    c = project.settings["comfyui"]
    client = ComfyClient(c["url"], c.get("timeout", 600))
    try:
        client.ping()
    except OSError as e:
        raise SystemExit(f"ComfyUI недоступен по {c['url']} ({e}). Запусти ComfyUI или используй --dry-run.")
    return client
