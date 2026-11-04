"""Отдельные картинки для игры: враги и боссы в 4 позах, битки, сюжетные вещи, наклейки, крупные планы.

Враги и боссы: база текстом (klein), остальные позы правкой базы (klein-edit), чтобы
персонаж в позах был тем же. Предметы и наклейки: по одной картинке (klein).
Крупные планы для миниигр: qwen, как фоны.

Результат:
  assets/enemies/<id>/<поза>.png (+ raw_<поза>.png)
  assets/sprites/<группа>/<id>.png (+ raw_<id>.png)
  assets/closeups/<id>.png
"""

from __future__ import annotations

import zlib
from pathlib import Path

from PIL import Image

from . import imagegen_backend as ig
from .config import ASSETS, Project
from .cutout import cutout, trim

ENEMIES = ASSETS / "enemies"
SPRITES = ASSETS / "sprites"
CLOSEUPS = ASSETS / "closeups"

GREY_BG = "isolated on a plain flat light grey background, no shadows on the background"
KEEP = ("Keep exactly the same character design, face, colors, proportions, outfit, camera framing and "
        "the plain light grey background. Change nothing else.")


def _seed(text: str) -> int:
    return zlib.crc32(text.encode()) % 10 ** 6


def _style(project: Project) -> str:
    return project.settings["style"]["character"]


def _progress(kind):
    return lambda d, n, st: print(f"\r  {kind}: {d}/{n} {st}   ", end="", flush=True)


def _cut(project: Project, img: Image.Image) -> Image.Image:
    cfg = project.settings.get("cutout", {})
    return trim(cutout(img.convert("RGB"), cfg.get("method", "auto"), cfg.get("tolerance", 28)))


# --- враги и боссы -----------------------------------------------------------------

def creature_base_prompt(project: Project, desc: str, stand: str) -> str:
    return ", ".join([f"full body shot of {desc}", stand,
                      "whole figure visible from head to toes with empty space around it, centered",
                      GREY_BG, _style(project)])


def creature_pose_prompt(pose_text: str) -> str:
    return f"Change only the pose: the character is now {pose_text}. " + KEEP


def creature_jobs(group: dict, poses: dict) -> list[tuple[str, str]]:
    """[(id, поза)] того, чего ещё нет."""
    out = []
    for cid in group:
        for pose in poses:
            if not (ENEMIES / cid / f"{pose}.png").exists():
                out.append((cid, pose))
    return out


def creatures(project: Project, group: dict, poses: dict, dry: bool = False) -> int:
    """group: {id: {prompt, poses?: {поза: текст}}}, poses: общие тексты поз (первая — базовая)."""
    s = project.settings
    model = s["imagegen"].get("character_model", "klein")
    w, h = s["sizes"]["character"]
    size = f"{w}x{h}"
    first = next(iter(poses))
    done = 0
    # 1. базы всех существ одной пачкой
    todo = [cid for cid in group if not (ENEMIES / cid / f"raw_{first}.png").exists()]
    if todo and not dry:
        tasks = [{"key": cid, "size": size, "seed": _seed(cid),
                  "prompt": creature_base_prompt(project, group[cid]["prompt"],
                                                 (group[cid].get("poses") or {}).get(first, poses[first])),
                  "negative": "blurry, deformed, extra limbs, text, watermark, background scenery, cropped"}
                 for cid in todo]
        raw = ig.run_batch(s, model, "enemies_base", tasks, dry=False, progress=_progress("enemies_base"))
        print()
        for cid, f in raw.items():
            d = ENEMIES / cid
            d.mkdir(parents=True, exist_ok=True)
            img = Image.open(f).convert("RGB")
            img.save(d / f"raw_{first}.png")
            _cut(project, img).save(d / f"{first}.png")
            done += 1
    # 2. остальные позы: пачка на существо, опора — его база
    for cid, c in group.items():
        d = ENEMIES / cid
        base = d / f"raw_{first}.png"
        need = [p for p in poses if p != first and not (d / f"raw_{p}.png").exists()]
        if not need or dry or not base.exists():
            continue
        edit = ig.register_edit(s, [base])
        texts = {**poses, **(c.get("poses") or {})}
        tasks = [{"key": p, "size": size, "seed": _seed(cid), "prompt": creature_pose_prompt(texts[p]),
                  "negative": "blurry, deformed, extra limbs, text, watermark, background scenery, cropped"}
                 for p in need]
        raw = ig.run_batch(s, edit, f"enemies_{cid}", tasks, dry=False, progress=_progress(cid))
        print()
        for p, f in raw.items():
            img = Image.open(f).convert("RGB")
            img.save(d / f"raw_{p}.png")
            _cut(project, img).save(d / f"{p}.png")
            done += 1
    return done


# --- предметы и наклейки -------------------------------------------------------------

def object_prompt(project: Project, desc: str) -> str:
    return ", ".join([f"a single {desc}", "isolated object, the whole object visible, centered with empty space around it",
                      GREY_BG, "comic book illustration, bold clean ink outlines, flat cel shading, vibrant colors"])


def sticker_prompt(desc: str) -> str:
    return ", ".join([f"a die-cut vinyl sticker of {desc}", "thick white border around the whole shape",
                      "bold black outlines, flat bright colors, 90s comic style, centered",
                      "on a plain flat medium grey background"])


def sprite_jobs(group_name: str, group: dict) -> list[str]:
    return [sid for sid in group if not (SPRITES / group_name / f"{sid}.png").exists()]


def sprites(project: Project, group_name: str, group: dict, sticker: bool = False) -> int:
    todo = sprite_jobs(group_name, group)
    if not todo:
        return 0
    s = project.settings
    tasks = [{"key": sid, "size": "1024x1024", "seed": _seed(f"{group_name}/{sid}"),
              "prompt": sticker_prompt(group[sid]["prompt"]) if sticker else object_prompt(project, group[sid]["prompt"]),
              "negative": "text, letters, watermark, blurry, photo, multiple objects, hands, person"}
             for sid in todo]
    raw = ig.run_batch(s, s["imagegen"].get("character_model", "klein"), f"sprites_{group_name}", tasks,
                       dry=False, progress=_progress(group_name))
    print()
    out = SPRITES / group_name
    out.mkdir(parents=True, exist_ok=True)
    for sid, f in raw.items():
        img = Image.open(f).convert("RGB")
        img.save(out / f"raw_{sid}.png")
        _cut(project, img).save(out / f"{sid}.png")
    return len(raw)


# --- крупные планы миниигр (qwen) ----------------------------------------------------

def closeup_jobs(group: dict) -> list[str]:
    return [cid for cid in group if not (CLOSEUPS / f"{cid}.png").exists()]


def closeups(project: Project, group: dict) -> int:
    todo = closeup_jobs(group)
    if not todo:
        return 0
    s = project.settings
    style = s["style"]["background"].replace(", no people, empty scene", "")
    tasks = [{"key": cid, "size": s["imagegen"].get("background_size", "wide"), "seed": _seed(f"closeup/{cid}"),
              "prompt": f"{group[cid]}, comic book panel, {style}",
              "negative": "text, letters, watermark, blurry, bare skin hands, deformed hands"} for cid in todo]
    raw = ig.run_batch(s, s["imagegen"].get("background_model", "qwen"), "closeups", tasks, dry=False,
                       progress=_progress("closeups"))
    print()
    CLOSEUPS.mkdir(parents=True, exist_ok=True)
    for cid, f in raw.items():
        ig.copy(f, CLOSEUPS / f"{cid}.png")
    return len(raw)


def contact_paths(group_dir: Path) -> list[Path]:
    return sorted(p for p in group_dir.rglob("*.png") if not p.name.startswith("raw_"))
