"""Вырезание персонажа из однотонного фона -> PNG с прозрачностью."""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def _floodfill(img: Image.Image, tolerance: int, min_hole: float = 0.0015) -> Image.Image:
    rgb = img.convert("RGB")
    w, h = rgb.size
    marker = (255, 0, 255)
    work = rgb.copy()
    for xy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0)]:
        if work.getpixel(xy) != marker:
            ImageDraw.floodfill(work, xy, marker, thresh=tolerance)
    # дырки внутри силуэта (между рук и головой, между ног) с краёв не достать:
    # ищем замкнутые островки цвета фона и тоже убираем, если они не крошечные
    a0 = np.array(rgb).astype(int)
    corners = np.array([a0[0, 0], a0[0, -1], a0[-1, 0], a0[-1, -1]])
    bg_col = np.median(corners, axis=0)
    close = np.abs(a0 - bg_col).max(axis=-1) <= tolerance // 2
    min_area = int(w * h * min_hole)
    probe, keep = (0, 255, 1), (1, 2, 3)
    step = 6
    for y in range(0, h, step):
        for x in range(0, w, step):
            if not close[y, x] or work.getpixel((x, y)) in (marker, keep):
                continue
            ImageDraw.floodfill(work, (x, y), probe, thresh=tolerance // 2)
            a = np.array(work)
            comp = np.all(a == probe, axis=-1)
            # островок должен быть почти весь цвета фона, иначе это серая одежда
            if comp.sum() >= min_area and close[comp].mean() > 0.97:
                a[comp] = marker
            else:
                a[comp] = keep
            work = Image.fromarray(a.astype("uint8"))
    a = np.array(work)
    bg = np.all(a == marker, axis=-1)
    alpha = Image.fromarray(np.where(bg, 0, 255).astype("uint8"))
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def cutout(img: Image.Image, method: str = "auto", tolerance: int = 28) -> Image.Image:
    if method == "none":
        return img.convert("RGBA")
    if method in ("auto", "rembg"):
        try:
            from rembg import remove  # type: ignore

            return remove(img.convert("RGB")).convert("RGBA")
        except ImportError:
            if method == "rembg":
                raise
    return _floodfill(img, tolerance)


def trim(img: Image.Image, pad: int = 4) -> Image.Image:
    """Обрезает прозрачные поля, чтобы низ картинки совпадал со ступнями."""
    bbox = img.getchannel("A").point(lambda v: 255 if v > 16 else 0).getbbox()
    if not bbox:
        return img
    l, t, r, b = bbox
    return img.crop((max(0, l - pad), max(0, t - pad), min(img.width, r + pad), min(img.height, b + 1)))
