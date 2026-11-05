"""Экспорт ассетов в браузерную игру: game/public/assets (webp + manifest.json).

    comix export-game

Берёт то, что уже есть: куклу героя (assets/doll, а если её нет, готовый экспорт web/doll),
фоны, врагов, вещи, наклейки и крупные планы. Чего нет, игра нарисует заглушкой.
Картинки уменьшаются, чтобы страница на GitHub Pages грузилась быстро.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from PIL import Image

from . import doll
from .config import ASSETS, ROOT, Project, load_yaml, CONFIG
from .poses import POSES
from .sprites import CLOSEUPS, ENEMIES, SPRITES

GAME_ASSETS = ROOT / "game" / "public" / "assets"


def _webp(src: Path, dst: Path, max_w: int, max_h: int) -> None:
    img = Image.open(src)
    img = img.convert("RGBA" if img.mode in ("RGBA", "LA", "P") else "RGB")
    s = min(1.0, max_w / img.width, max_h / img.height)
    if s < 1:
        img = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, "WEBP", quality=84, method=6)


def _fresh(d: Path) -> Path:
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    return d


def _pngs(d: Path):
    return sorted(p for p in d.glob("*.png") if not p.name.startswith("raw_"))


def _titles(world: str) -> dict:
    path = CONFIG / "factory" / f"{world}.yaml"
    f = load_yaml(path) if path.exists() else {}
    out = {}
    for group in ("enemies", "bosses", "weapons", "props", "stickers"):
        for k, v in (f.get(group) or {}).items():
            if isinstance(v, dict) and v.get("title"):
                out[k] = v["title"]
    return out


def export_game(project: Project, out: Path = GAME_ASSETS, world: str = "city") -> dict:
    out.mkdir(parents=True, exist_ok=True)
    titles = _titles(world)
    man: dict = {"backgrounds": {}, "enemies": {}, "sprites": {}, "closeups": {}, "poses": {}}
    counts = {}

    # кукла героя: готовый экспорт web/doll (его только что сделала стадия hero_process),
    # а если assets/doll новее, то свежий экспорт из него
    web_doll = ROOT / "web" / "doll"
    src_m, web_m = doll.DOLL / "manifest.json", web_doll / "manifest.json"
    if src_m.exists() and (not web_m.exists() or src_m.stat().st_mtime > web_m.stat().st_mtime):
        doll.export(_fresh(out / "doll"), 0.5)
    elif web_m.exists():
        shutil.copytree(web_doll, _fresh(out / "doll"), dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("*.html"))
    if (out / "doll" / "manifest.json").exists():
        man["doll"] = json.loads((out / "doll" / "manifest.json").read_text(encoding="utf-8"))
        _prefix_doll(man["doll"], "doll/")
        counts["кукла, поз"] = sum(len(g) for g in man["doll"]["genders"].values())

    # фоны: все локации из config/backgrounds.yaml, цвет нужен заглушке
    bg_src = ASSETS / "backgrounds"
    if any(bg_src.glob("*/*.png")):
        _fresh(out / "backgrounds")
    n = 0
    for loc, spec in project.backgrounds.items():
        entry = {"color": (spec or {}).get("color"), "variations": {}}
        for var in project.location_variations(loc):
            src = bg_src / loc / f"{var}.png"
            rel = f"backgrounds/{loc}/{var}.webp"
            if src.exists():
                _webp(src, out / rel, 1280, 1280)
            if (out / rel).exists():
                entry["variations"][var] = rel
                n += 1
        man["backgrounds"][loc] = entry
    counts["фоны"] = n

    # враги, подручные и злодей: assets/enemies/<id>/<поза>.png
    if any(ENEMIES.glob("*/*.png")):
        _fresh(out / "enemies")
        for d in sorted(p for p in ENEMIES.iterdir() if p.is_dir()):
            poses = {}
            for f in _pngs(d):
                rel = f"enemies/{d.name}/{f.stem}.webp"
                _webp(f, out / rel, 640, 768)
                poses[f.stem] = rel
            if poses:
                man["enemies"][d.name] = {"title": titles.get(d.name), "poses": poses}
    counts["враги"] = len(man["enemies"])

    # вещи, сюжетные предметы, наклейки: assets/sprites/<группа>/<id>.png
    if any(SPRITES.glob("*/*.png")):
        _fresh(out / "sprites")
        for d in sorted(p for p in SPRITES.iterdir() if p.is_dir()):
            group = {}
            for f in _pngs(d):
                rel = f"sprites/{d.name}/{f.stem}.webp"
                _webp(f, out / rel, 384, 384)
                group[f.stem] = {"title": titles.get(f.stem), "src": rel}
            if group:
                man["sprites"][d.name] = group
    counts["вещи"] = sum(len(g) for g in man["sprites"].values())

    if any(CLOSEUPS.glob("*.png")):
        _fresh(out / "closeups")
        for f in _pngs(CLOSEUPS):
            rel = f"closeups/{f.stem}.webp"
            _webp(f, out / rel, 1280, 1280)
            man["closeups"][f.stem] = rel
    counts["крупные планы"] = len(man["closeups"])

    # позы: названия и скелет (по нему игра рисует манекен, если куклы ещё нет)
    for pid, p in POSES.items():
        man["poses"][pid] = {"title": p["title"],
                             "points": {str(k): [round(x, 3), round(y, 3)] for k, (x, y) in p["points"].items()}}

    (out / "manifest.json").write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding="utf-8")
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file()) / 1e6
    print("Экспорт в игру: " + ", ".join(f"{k} {v}" for k, v in counts.items()) + f". Всего {size:.1f} МБ в {out}")
    return man


def _prefix_doll(m: dict, pre: str) -> None:
    for g in m.get("genders", {}).values():
        for e in g.values():
            e["base"] = {k: pre + v for k, v in e["base"].items()}
            e["layers"] = {s: {k: pre + v for k, v in d.items()} for s, d in e["layers"].items()}
            for face in (e.get("faces") or {}).values():
                for key in ("layer", "skin", "erase"):
                    if face.get(key):
                        face[key] = pre + face[key]
            for key in ("skin_mask", "shorts_mask"):
                if e.get(key):
                    e[key] = pre + e[key]
