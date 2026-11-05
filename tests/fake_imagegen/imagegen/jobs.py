"""Фейковый ImageGen: рисует простые картинки вместо нейросети, чтобы прогнать пайплайн comix целиком.

Проверяет, что графы пресетов собираются и ссылки в них не битые, и по словам промпта
рисует фигуру в нужной позе, вещь в нужном слоте, лицо и т.д.
"""
import itertools
import os
import sys
import zlib
from pathlib import Path
from types import SimpleNamespace

from PIL import Image, ImageDraw

from . import presets

_JOBS = {}
_ids = itertools.count(1)
SIZES = {"portrait": (832, 1216), "wide": (1344, 768), "square": (1024, 1024)}
BG = (214, 214, 214)
CALLS = []  # для тестов: (model, n, refs)


def _size(s):
    if s in SIZES:
        return SIZES[s]
    w, h = str(s).lower().split("x")
    return int(w), int(h)


def _check_graph(g):
    for nid, node in g.items():
        for v in node.get("inputs", {}).values():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                assert v[0] in g, f"битая ссылка {nid} -> {v[0]}"


def _poses():
    root = Path(__file__).resolve().parents[3]
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    from comix.poses import POSES
    return POSES


def _which_pose(prompt):
    poses = _poses()
    for pid, p in poses.items():
        if p["prompt"] in prompt:
            return pid
    return "idle"


def _figure(size, pose, colors, jitter=0):
    w, h = size
    img = Image.new("RGB", size, BG)
    d = ImageDraw.Draw(img)
    pts = {k: (x * w + jitter, y * h) for k, (x, y) in _poses()[pose]["points"].items()}
    skin = colors.get("skin", (234, 195, 162))
    lw = int(w * 0.045)
    for a, b in [(2, 3), (3, 4), (5, 6), (6, 7)]:
        d.line([pts[a], pts[b]], fill=colors.get("arms", skin), width=lw)
    for a, b in [(8, 9), (9, 10), (11, 12), (12, 13)]:
        d.line([pts[a], pts[b]], fill=colors.get("legs", skin), width=int(lw * 1.2))
    for k in (10, 13):
        x, y = pts[k]
        d.rectangle([x - lw, y - lw * 0.4, x + lw * 1.1, y + lw * 0.6], fill=colors.get("feet", skin))
    torso = [pts[2][0], pts[2][1], pts[11][0], pts[11][1]]
    d.rectangle(torso, fill=colors.get("top", (250, 250, 250)))
    d.rectangle([pts[8][0], pts[8][1] - h * 0.03, pts[11][0], pts[8][1] + h * 0.05], fill=colors.get("shorts", (140, 180, 230)))
    hx, hy = pts[0]
    r = w * 0.055
    d.ellipse([hx - r, hy - r * 1.2, hx + r, hy + r], fill=skin)
    d.ellipse([hx - r, hy - r * 1.4, hx + r, hy - r * 0.2], fill=colors.get("hair", (90, 60, 40)))
    if "hat" in colors:
        d.rectangle([hx - r * 1.3, hy - r * 1.6, hx + r * 1.3, hy - r * 0.9], fill=colors["hat"])
    if "mask" in colors:
        d.rectangle([hx - r, hy - r * 0.5, hx + r, hy - r * 0.1], fill=colors["mask"])
    d.line([hx - r * 0.4, hy + r * 0.4, hx + r * 0.4, hy + r * (0.4 if "smile" not in colors else 0.6)],
           fill=colors.get("mouth", (120, 40, 40)), width=4)
    return img


def _color(text):
    c = zlib.crc32(text.encode())
    return (40 + c % 180, 40 + (c >> 8) % 180, 40 + (c >> 16) % 180)


def _render(item, refs, model):
    size = _size(item.get("size", "portrait"))
    prompt = item["prompt"]
    seed = int(item.get("seed", 0))
    if model.startswith("qwen"):
        img = Image.new("RGB", size, _color(prompt))
        d = ImageDraw.Draw(img)
        for i in range(6):
            x = (seed * 37 + i * 211) % size[0]
            d.rectangle([x, size[1] * 0.3, x + 120, size[1]], fill=_color(prompt + str(i)))
        return img
    if not refs:
        if "full body" in prompt:
            return _figure(size, _which_pose(prompt), {"skin": (234, 195, 162), "top": _color(prompt)})
        img = Image.new("RGB", size, BG if "medium grey" not in prompt else (150, 150, 150))
        d = ImageDraw.Draw(img)
        w, h = size
        if "sticker" in prompt:
            d.ellipse([w * 0.2, h * 0.2, w * 0.8, h * 0.8], fill=(255, 255, 255))
        d.ellipse([w * 0.25, h * 0.25, w * 0.75, h * 0.75], fill=_color(prompt))
        return img
    # правка: восстанавливаем «персонажа» по ключевым словам
    colors = {}
    pose = _which_pose(prompt)
    if "Change only the pose: the person" not in prompt and "stick-figure" not in prompt:
        ref_prompt = Path(refs[0]).name
        pose = "idle"
        for pid in _poses():
            if f"/{pid}/" in str(refs[0]).replace("\\", "/"):
                pose = pid
    if "on the person's head" in prompt:
        colors["hat"] = _color(prompt)
    if "on the person's face" in prompt:
        colors["mask"] = _color(prompt)
    if "upper body" in prompt:
        colors["top"] = _color(prompt)
        colors["arms"] = _color(prompt)
    if "legs" in prompt:
        colors["legs"] = _color(prompt)
        colors["shorts"] = _color(prompt)
    if "on the person's feet" in prompt:
        colors["feet"] = _color(prompt)
    if "facial expression" in prompt:
        colors["mouth"] = _color(prompt)
        colors["smile"] = True
    if "person's head: make them" in prompt:
        colors["hair"] = _color(prompt)
    if "the character is now" in prompt:  # враги: просто перекрашиваем исходник
        img = Image.open(refs[0]).convert("RGB")
        img.paste(_color(prompt), [0, 0, 40, 40])
        return img
    jitter = (seed % 3) - 1 if "stick-figure" in prompt else 0
    if "stick-figure" in prompt and seed % 2:  # иногда «не понимает» скелет
        pose = "idle"
    return _figure(size, pose, colors, jitter)


def generate(out_dir, model, items):
    p = presets.PRESETS[model]
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    files, refs_all = [], set()
    for it in items:
        g = p.build(SimpleNamespace(**it))
        _check_graph(g)
        refs = [n["inputs"]["path"] for n in g.values() if n["class_type"] == "ImageGenLoadImage"]
        refs_all.update(refs)
        img = _render(it, refs, "qwen" if model.startswith("qwen") else "klein")
        f = out / f"{it['name']}.png"
        img.save(f)
        files.append({"file": str(f), "seed": it.get("seed"), "state": "done"})
    CALLS.append((model, len(items), sorted(refs_all)))
    job = next(_ids)
    _JOBS[job] = len(items)
    return {"job": job, "files": files}


def status(job):
    return {"state": "done", "counts": {"done": _JOBS[job]}}


def server(action="stop", when="idle"):
    return {"ok": True}


def models():
    return [{"name": n, "model": n, "installed": True} for n in presets.PRESETS]
