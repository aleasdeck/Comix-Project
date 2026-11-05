"""Убрать брак, чтобы следующий `comix night` нарисовал его заново.

Ничего не удаляется: файлы уезжают в assets/_redo/<время>/ с теми же относительными путями,
вернуть можно простым копированием назад. comix night пропускает то, что уже есть,
поэтому после переноса он перерисует ровно убранное (с текущими промптами и скелетами).
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from .config import ASSETS
from .doll import DOLL
from .sprites import CLOSEUPS, ENEMIES, SPRITES


def _move(src: Path, dst_root: Path) -> int:
    if not src.exists():
        return 0
    dst = dst_root / src.relative_to(ASSETS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    n = sum(1 for _ in src.rglob("*")) if src.is_dir() else 1
    src.replace(dst)
    return n


def redo(poses: list[str] = (), items: list[str] = (), enemies: list[str] = (), sprites: list[str] = (),
         closeups: list[str] = ()) -> dict:
    """poses: male/victory; items: top/hero_suit_top (во всех позах обоих полов);
    enemies: drone; sprites: weapons/crowbar; closeups: hack_done."""
    root = ASSETS / "_redo" / time.strftime("%Y%m%d-%H%M%S")
    moved = {}
    for gp in poses:
        g, p = gp.split("/")
        moved[f"pose {gp}"] = _move(DOLL / g / p, root)
    for si in items:
        slot, item = si.split("/")
        n = 0
        for d in sorted(DOLL.glob("*/*")):
            if not d.is_dir() or d.name.startswith("_"):
                continue
            for f in list(d.glob(f"raw_{slot}__{item}.png")) + list(d.glob(f"raw_{slot}__{item}_try*.png")) \
                    + list(d.glob(f"{slot}__{item}.png")) + list(d.glob(f"{slot}__{item}_*.png")):
                n += _move(f, root)
            qa_path = d / "qa.json"
            if qa_path.exists():
                qa = json.loads(qa_path.read_text())
                key = f"{slot}__{item}"
                if qa.pop(key, None) is not None:
                    qa_path.write_text(json.dumps(qa, ensure_ascii=False, indent=1))
        moved[f"item {si}"] = n
    for e in enemies:
        moved[f"enemy {e}"] = _move(ENEMIES / e, root)
    for gs in sprites:
        group, sid = gs.split("/")
        moved[f"sprite {gs}"] = _move(SPRITES / group / f"{sid}.png", root) + _move(SPRITES / group / f"raw_{sid}.png", root)
    for c in closeups:
        moved[f"closeup {c}"] = _move(CLOSEUPS / f"{c}.png", root)
    return {"to": str(root), "moved": moved}
