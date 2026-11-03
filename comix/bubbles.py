"""Облачка для текста, рисуются кодом (а не нейросетью): ровный контур,
размер подгоняется под текст, хвостик направляется на говорящего.

Типы:
  speech  — обычная реплика (овал с хвостиком)
  thought — мысли (облако с кружочками)
  shout   — крик (взрывная звезда)
  whisper — шёпот (пунктирный контур)
  caption — подпись автора (прямоугольник)
"""

from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .config import ROOT

KINDS = ("speech", "thought", "shout", "whisper", "caption")
SS = 2  # суперсэмплинг для гладких краёв

FILL = {"caption": (255, 244, 196, 255)}
INK = (15, 15, 15, 255)


@lru_cache(maxsize=32)
def load_font(candidates: tuple, size: int) -> ImageFont.FreeTypeFont:
    for c in candidates:
        p = Path(c)
        if not p.is_absolute():
            p = ROOT / p
        if p.exists():
            return ImageFont.truetype(str(p), size)
    for name in ("DejaVuSans-Bold.ttf", "arialbd.ttf", "Arial Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size)


def wrap(text: str, font: ImageFont.FreeTypeFont, max_width: float) -> list[str]:
    lines = []
    for para in text.split("\n"):
        cur = ""
        for word in para.split():
            test = (cur + " " + word).strip()
            if font.getlength(test) <= max_width or not cur:
                cur = test
            else:
                lines.append(cur)
                cur = word
        lines.append(cur)
    return lines


def _ellipse_edge(cx, cy, a, b, dx, dy):
    n = math.hypot(dx, dy) or 1
    dx, dy = dx / n, dy / n
    t = 1 / math.sqrt((dx / a) ** 2 + (dy / b) ** 2)
    return cx + dx * t, cy + dy * t


def render(kind: str, text: str, font: ImageFont.FreeTypeFont, max_text_width: int = 380,
           tail: tuple[float, float] | None = (0.0, 1.0), stroke: int = 4,
           blank_size: tuple[int, int] | None = None) -> tuple[Image.Image, tuple[int, int]]:
    """Рисует облачко.

    tail — вектор от центра облачка до кончика хвостика в пикселях
    (None — без хвостика). Возвращает (RGBA картинка, координаты центра
    облачка на этой картинке), чтобы вызывающий мог поставить центр в нужную точку.
    """
    if kind not in KINDS:
        raise ValueError(f"Неизвестный тип облачка '{kind}', есть: {KINDS}")
    bigfont = font.font_variant(size=font.size * SS)
    lines = wrap(text, font, max_text_width) if text else [""]
    asc, desc = font.getmetrics()
    line_h = int((asc + desc) * 1.12)
    tw = max([font.getlength(l) for l in lines] + [font.size * 2])
    th = line_h * len(lines)
    if blank_size:  # пустое облачко заданного размера под свой текст
        lines, (tw, th) = [], blank_size

    if kind == "caption":
        a, b = tw / 2 + font.size * 0.7, th / 2 + font.size * 0.55
        tail = None
    else:
        k = {"shout": 0.86, "thought": 0.80}.get(kind, 0.74)
        a = tw / 2 / k + font.size * 0.6
        b = th / 2 / k + font.size * 0.5
    if kind == "shout":
        spikes = 1.3
    elif kind == "thought":
        spikes = 1.25
    else:
        spikes = 1.0

    tx, ty = tail if tail else (0, 0)
    margin = stroke * 3 + 4
    left = min(-a * spikes, tx) - margin
    right = max(a * spikes, tx) + margin
    top = min(-b * spikes, ty) - margin
    bottom = max(b * spikes, ty) + margin
    W, H = int(right - left), int(bottom - top)
    cx, cy = -left, -top

    S = SS
    mask = Image.new("L", (W * S, H * S), 0)
    d = ImageDraw.Draw(mask)
    C = (cx * S, cy * S)
    A, B = a * S, b * S

    if kind == "caption":
        d.rectangle([C[0] - A, C[1] - B, C[0] + A, C[1] + B], fill=255)
    elif kind == "shout":
        n = 22
        pts = []
        for i in range(n * 2):
            ang = math.pi * i / n
            r = 1.0 if i % 2 else spikes - (0.08 if i % 4 == 0 else 0)
            pts.append((C[0] + math.cos(ang) * A * r, C[1] + math.sin(ang) * B * r))
        d.polygon(pts, fill=255)
    elif kind == "thought":
        d.ellipse([C[0] - A * 0.92, C[1] - B * 0.92, C[0] + A * 0.92, C[1] + B * 0.92], fill=255)
        n = 11
        for i in range(n):
            ang = 2 * math.pi * i / n + 0.3
            px, py = C[0] + math.cos(ang) * A * 0.98, C[1] + math.sin(ang) * B * 0.98
            r = min(A, B) * (0.42 if i % 2 else 0.36)
            d.ellipse([px - r, py - r, px + r, py + r], fill=255)
    else:
        d.ellipse([C[0] - A, C[1] - B, C[0] + A, C[1] + B], fill=255)

    if tail and kind != "caption":
        TX, TY = (cx + tx) * S, (cy + ty) * S
        if kind == "thought":
            ex, ey = _ellipse_edge(C[0], C[1], A * spikes, B * spikes, TX - C[0], TY - C[1])
            for i, f in enumerate((0.25, 0.6, 0.92)):
                px, py = ex + (TX - ex) * f, ey + (TY - ey) * f
                r = min(A, B) * (0.16 - i * 0.045)
                d.ellipse([px - r, py - r, px + r, py + r], fill=255)
        else:
            dx, dy = TX - C[0], TY - C[1]
            n = math.hypot(dx, dy) or 1
            px, py = -dy / n, dx / n
            base_w = min(A, B) * 0.32
            bx, by = C[0] + dx / n * min(A, B) * 0.4, C[1] + dy / n * min(A, B) * 0.4
            # слегка изогнутый хвостик: смещаем основание в сторону
            d.polygon([(bx + px * base_w, by + py * base_w),
                       (bx - px * base_w * 0.2, by - py * base_w * 0.2),
                       (TX, TY)], fill=255)

    outer = mask.filter(ImageFilter.MaxFilter(2 * stroke * S + 1))
    if kind == "whisper":
        dash = Image.new("L", mask.size, 0)
        dd = ImageDraw.Draw(dash)
        R = max(W, H) * S
        for i in range(0, 360, 10):
            dd.pieslice([C[0] - R, C[1] - R, C[0] + R, C[1] + R], i, i + 6, fill=255)
        ring = Image.composite(outer, Image.new("L", mask.size, 0), dash)
        outer = Image.composite(Image.new("L", mask.size, 255), ring, mask)

    img = Image.new("RGBA", mask.size, (0, 0, 0, 0))
    img.paste(Image.new("RGBA", mask.size, INK), (0, 0), outer)
    img.paste(Image.new("RGBA", mask.size, FILL.get(kind, (255, 255, 255, 255))), (0, 0), mask)

    td = ImageDraw.Draw(img)
    y = C[1] - th * S / 2
    for line in lines:
        lw = bigfont.getlength(line)
        td.text((C[0] - lw / 2, y), line, font=bigfont, fill=INK)
        y += line_h * S

    img = img.resize((W, H), Image.LANCZOS)
    return img, (int(cx), int(cy))


def export_pack(font: ImageFont.FreeTypeFont, out_dir: Path) -> list[Path]:
    """Набор пустых и примерных облачков PNG для ручной вёрстки."""
    out_dir.mkdir(parents=True, exist_ok=True)
    samples = {
        "speech": "Привет! Это обычная реплика.",
        "thought": "Хм... а что если...",
        "shout": "БЕГИ!!!",
        "whisper": "тише, нас услышат",
        "caption": "Тем временем на другом конце города...",
    }
    tails = {"down": (0, 1), "down_left": (-0.8, 1), "down_right": (0.8, 1), "up": (0, -1), "none": None}
    paths = []
    for kind in KINDS:
        for tname, t in tails.items():
            if kind == "caption" and tname != "none":
                continue
            for label, text in (("empty", ""), ("sample", samples[kind])):
                vec = (t[0] * 160, t[1] * 160) if t else None
                blank = (320, 90) if label == "empty" else None
                img, _ = render(kind, text, font, tail=vec, blank_size=blank)
                p = out_dir / f"{kind}_{tname}_{label}.png"
                img.save(p)
                paths.append(p)
    return paths
