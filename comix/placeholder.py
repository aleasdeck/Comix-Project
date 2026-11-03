"""Черновые картинки вместо сгенерированных.

Позволяют собрать и проверить страницу комикса (раскладку, позы, смену
одежды, облачка) ещё до того, как что-то сгенерировано в ComfyUI.
Персонаж рисуется по скелету позы цветами кожи и одежды.
"""

from __future__ import annotations

import hashlib

from PIL import Image, ImageDraw, ImageFont

from .config import CharacterShot, Project
from .poses import POSES

OUTLINE = (20, 20, 20, 255)


def _rgb(hexcolor: str | None, default=(180, 180, 180)):
    if not hexcolor:
        return default
    h = hexcolor.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _limb(d: ImageDraw.ImageDraw, a, b, width, color):
    d.line([a, b], fill=OUTLINE, width=width + 6)
    d.line([a, b], fill=color, width=width)
    for p in (a, b):
        r = width / 2
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=color)


def character(project: Project, shot: CharacterShot, size=(832, 1216)) -> Image.Image:
    w, h = size
    pts = {k: (x * w, y * h) for k, (x, y) in POSES[shot.pose]["points"].items()}
    c = project.character(shot.char_id)
    o = shot.outfit_dict
    skin = _rgb(project.skin_tones.get(c.get("skin"), {}).get("color"), (230, 190, 160))
    top = _rgb(project.item("top", o["top"]).get("color"))
    bottom = _rgb(project.item("bottom", o["bottom"]).get("color"))
    shoes = _rgb(project.item("shoes", o["shoes"]).get("color"), (60, 60, 60))
    head_item = project.item("head", o["head"])

    img = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    lw = int(w * 0.075)

    # ноги
    for hip, knee, ank in ((8, 9, 10), (11, 12, 13)):
        _limb(d, pts[hip], pts[knee], lw, bottom)
        _limb(d, pts[knee], pts[ank], lw, bottom)
        x, y = pts[ank]
        d.rounded_rectangle([x - lw * 0.75, y - lw * 0.35, x + lw * 0.75, y + lw * 0.45],
                            radius=lw * 0.3, fill=shoes, outline=OUTLINE, width=3)
    # торс
    torso = [pts[2], pts[5], pts[11], pts[8]]
    torso = [(torso[0][0] - lw * 0.3, torso[0][1]), (torso[1][0] + lw * 0.3, torso[1][1]),
             (torso[2][0] + lw * 0.2, torso[2][1] + lw * 0.3), (torso[3][0] - lw * 0.2, torso[3][1] + lw * 0.3)]
    d.polygon(torso, fill=top, outline=OUTLINE, width=4)
    # руки: рукав цвета верха, кисть цвета кожи
    for sh, el, wr in ((2, 3, 4), (5, 6, 7)):
        _limb(d, pts[sh], pts[el], int(lw * 0.8), top)
        _limb(d, pts[el], pts[wr], int(lw * 0.7), top)
        x, y = pts[wr]
        r = lw * 0.45
        d.ellipse([x - r, y - r, x + r, y + r], fill=skin, outline=OUTLINE, width=3)
    # шея и голова
    _limb(d, pts[1], pts[0], int(lw * 0.5), skin)
    hx, hy = pts[0]
    hr = w * 0.075
    hy -= hr * 0.35
    d.ellipse([hx - hr, hy - hr * 1.15, hx + hr, hy + hr * 1.15], fill=skin, outline=OUTLINE, width=4)
    for ex in (pts[14][0], pts[15][0]):
        d.ellipse([ex - 5, hy - 8, ex + 5, hy + 4], fill=OUTLINE)
    # голова: шляпа или маска
    hc = head_item.get("color")
    if hc:
        col = _rgb(hc)
        if head_item.get("kind") == "mask":
            d.rectangle([hx - hr, hy - hr * 0.25, hx + hr, hy + hr * 0.2], fill=col, outline=OUTLINE, width=3)
        else:
            d.chord([hx - hr * 1.05, hy - hr * 1.5, hx + hr * 1.05, hy - hr * 0.1], 180, 360,
                    fill=col, outline=OUTLINE, width=3)
            d.rectangle([hx - hr * 1.35, hy - hr * 0.85, hx + hr * 1.35, hy - hr * 0.65], fill=col, outline=OUTLINE, width=3)
    return img


def background(project: Project, location: str, variation: str, size=(1664, 928)) -> Image.Image:
    w, h = size
    base = _rgb(project.backgrounds.get(location, {}).get("color"), (150, 160, 180))
    night = "night" in variation
    sunset = "sunset" in variation
    top = tuple(int(c * (0.45 if night else 1.1)) for c in base)
    if sunset:
        top = (240, 150, 90)
    top = tuple(min(255, v) for v in top)
    bottom = tuple(int(c * (0.3 if night else 0.75)) for c in base)
    img = Image.new("RGB", size)
    d = ImageDraw.Draw(img)
    horizon = int(h * (0.45 if "high" in variation else 0.72 if "low" in variation else 0.6))
    for y in range(h):
        t = y / max(1, horizon) if y < horizon else 1.0
        col = tuple(int(top[i] * (1 - t) + bottom[i] * t) for i in range(3))
        d.line([(0, y), (w, y)], fill=col)
    # простые "здания" для ощущения глубины
    rnd = int(hashlib.md5((location + variation).encode()).hexdigest(), 16)
    x = 0
    while x < w:
        bw = 80 + rnd % 160
        rnd //= 7
        bh = int(h * (0.15 + (rnd % 30) / 100))
        rnd = rnd // 5 or int(hashlib.md5(str(x).encode()).hexdigest(), 16)
        shade = tuple(int(v * 0.6) for v in bottom)
        d.rectangle([x, horizon - bh, x + bw - 6, horizon], fill=shade, outline=(30, 30, 30), width=3)
        x += bw
    d.line([(0, horizon), (w, horizon)], fill=(30, 30, 30), width=4)
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 36)
    except OSError:
        font = ImageFont.load_default()
    d.text((24, 20), f"[черновик] {location}/{variation}", fill=(255, 255, 255), font=font,
           stroke_width=3, stroke_fill=(0, 0, 0))
    return img
