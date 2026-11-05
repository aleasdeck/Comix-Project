"""Проба: может ли сегментатор SAM 2.1 уточнить маски слоёв куклы.

Боевой код нарезки это не меняет. Текущая маска слоя служит подсказкой (рамка и точки), SAM
предлагает свою, результат кладётся рядом в docs/sam_probe/compare.png: правка | текущий слой |
слой SAM, по строке на слой.

Запускать питоном ComfyUI, там есть torch с поддержкой видеокарты и transformers:
    C:\\Windows\\System32\\.venv\\Scripts\\python.exe scripts\\sam_probe.py
Веса лежат вне репозитория, см. MODEL ниже.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from transformers import Sam2Model, Sam2Processor

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from comix.cutout import cutout  # noqa: E402  (только numpy и Pillow, настройки проекта не нужны)

MODEL = Path(r"D:\VibeProjects\models\sam2.1-hiera-large")
DOLL = ROOT / "assets" / "doll"
OUT = ROOT / "docs" / "sam_probe" / "compare.png"
MAX_BYTES = 2 * 1024 * 1024

# Трудные слои: тренч на коже, шляпа с волосами, маска, тёмная кожанка в сложной позе, куртка героя.
LAYERS = [
    ("male", "idle", "top__trench_coat"),
    ("female", "idle", "top__trench_coat"),
    ("male", "victory", "top__trench_coat"),
    ("female", "victory", "top__trench_coat"),
    ("female", "idle", "head__fedora"),
    ("male", "idle", "head__hero_mask"),
    ("male", "run", "top__leather_jacket"),
    ("male", "fight", "top__hero_suit_top"),
]
N_POS, N_NEG = 8, 5


def erode(m: np.ndarray, r: int) -> np.ndarray:
    img = Image.fromarray((m * 255).astype("uint8")).filter(ImageFilter.MinFilter(2 * r + 1))
    return np.asarray(img) > 128


def dilate(m: np.ndarray, r: int) -> np.ndarray:
    img = Image.fromarray((m * 255).astype("uint8")).filter(ImageFilter.MaxFilter(2 * r + 1))
    return np.asarray(img) > 128


def spread_points(m: np.ndarray, n: int) -> list[list[float]]:
    """Точки, разнесённые по области: каждая следующая дальше всех от уже взятых."""
    ys, xs = np.nonzero(m)
    if len(xs) == 0:
        return []
    pts = np.stack([xs, ys], 1).astype("float32")
    if len(pts) > 20000:
        pts = pts[np.random.default_rng(0).choice(len(pts), 20000, replace=False)]
    chosen = [pts[np.argmin(((pts - pts.mean(0)) ** 2).sum(1))]]
    dist = ((pts - chosen[0]) ** 2).sum(1)
    for _ in range(n - 1):
        i = int(np.argmax(dist))
        chosen.append(pts[i])
        dist = np.minimum(dist, ((pts - pts[i]) ** 2).sum(1))
    return [[float(x), float(y)] for x, y in chosen]


def prompts(cur: np.ndarray, d: Path) -> tuple[list[float], list[list[float]], list[int]]:
    """Рамка маски, положительные точки глубоко внутри, отрицательные на коже и шортах вне маски."""
    ys, xs = np.nonzero(cur)
    box = [float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())]
    inner = cur
    for r in (9, 6, 3):  # у тонких вещей (маска) глубокой сердцевины может не быть
        e = erode(cur, r)
        if e.sum() > 300:
            inner = e
            break
    pos = spread_points(inner, N_POS)
    skin = np.asarray(Image.open(d / "skin_mask.png").convert("L")) > 128
    shorts = np.asarray(Image.open(d / "shorts_mask.png").convert("L")) > 128
    neg_area = (skin | shorts) & ~dilate(cur, 8)
    near = np.zeros_like(cur)
    x0, y0, x1, y1 = (int(v) for v in box)
    pad = 40
    near[max(0, y0 - pad):y1 + pad, max(0, x0 - pad):x1 + pad] = True
    neg = spread_points(erode(neg_area & near, 2), N_NEG) or spread_points(neg_area & near, N_NEG)
    return box, pos + neg, [1] * len(pos) + [0] * len(neg)


def checker(size: tuple[int, int], cell: int = 12) -> Image.Image:
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w]
    v = np.where(((xx // cell) + (yy // cell)) % 2 == 0, 205, 245).astype("uint8")
    return Image.fromarray(np.dstack([v, v, v]), "RGB")


def on_checker(rgb: Image.Image, alpha: Image.Image) -> Image.Image:
    bg = checker(rgb.size)
    bg.paste(rgb, mask=alpha)
    return bg


def main():
    if not torch.cuda.is_available():
        sys.exit("Нет видеокарты в torch: запускай питоном ComfyUI")
    dev = "cuda"
    t0 = time.time()
    proc = Sam2Processor.from_pretrained(MODEL, local_files_only=True)
    model = Sam2Model.from_pretrained(MODEL, local_files_only=True).to(dev).eval()
    torch.cuda.synchronize()
    print(f"загрузка модели {time.time() - t0:.1f} с, видеопамять {torch.cuda.memory_allocated() / 2**30:.2f} ГБ", flush=True)
    torch.cuda.reset_peak_memory_stats()

    rows, stats = [], []
    for g, pose, name in LAYERS:
        d = DOLL / g / pose
        layer = Image.open(d / f"{name}.png").convert("RGBA")
        rgb = layer.convert("RGB")  # в слое лежит вся выровненная правка, маска только в альфе
        cur_a = layer.getchannel("A")
        cur = np.asarray(cur_a) > 128
        box, points, labels = prompts(cur, d)
        t1 = time.time()
        inputs = proc(images=rgb, input_points=[[points]], input_labels=[[labels]], input_boxes=[[box]],
                      return_tensors="pt").to(dev)
        with torch.no_grad():
            out = model(**inputs, multimask_output=False)
        masks = proc.post_process_masks(out.pred_masks.cpu(), inputs["original_sizes"])[0]
        torch.cuda.synchronize()
        sec = time.time() - t1
        sam = masks.reshape(-1, *masks.shape[-2:])[0].numpy() > 0
        fig = np.asarray(cutout(rgb, "floodfill", 28).getchannel("A")) > 128
        sam &= fig  # результат пересекаем с силуэтом фигуры
        sam_a = Image.fromarray((sam * 255).astype("uint8")).filter(ImageFilter.GaussianBlur(1.0))
        iou = float((sam & cur).sum()) / max(1, int((sam | cur).sum()))
        only_sam = float((sam & ~cur).sum()) / max(1, int(cur.sum()))
        only_cur = float((cur & ~sam).sum()) / max(1, int(cur.sum()))
        stat = {"layer": f"{g}/{pose}/{name}", "iou": round(iou, 3), "sam_adds": round(only_sam, 3),
                "sam_drops": round(only_cur, 3), "sec": round(sec, 2), "pos": labels.count(1), "neg": labels.count(0),
                "score": round(float(out.iou_scores.flatten()[0]), 3)}
        stats.append(stat)
        print(stat, flush=True)
        rows.append((stat, rgb, cur_a, sam_a, cur | sam))

    peak = torch.cuda.max_memory_allocated() / 2**30
    print(f"пик видеопамяти {peak:.2f} ГБ", flush=True)
    sheet(rows)
    (ROOT / "build" / "sam_probe_stats.json").write_text(
        json.dumps({"peak_gb": round(peak, 2), "layers": stats}, ensure_ascii=False, indent=1), encoding="utf-8")


def sheet(rows):
    font = ImageFont.truetype("arial.ttf", 15)
    th, cols = 300, 3
    tiles = []
    for stat, rgb, cur_a, sam_a, union in rows:
        ys, xs = np.nonzero(union)
        pad = 24
        crop = (max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad),
                min(rgb.width, int(xs.max()) + pad), min(rgb.height, int(ys.max()) + pad))
        r = rgb.crop(crop)
        tw = max(1, int(r.width * th / r.height))
        if tw > 360:
            tw = 360
        size = (tw, int(r.height * tw / r.width))
        tiles.append((stat, [r.resize(size, Image.LANCZOS),
                             on_checker(r, cur_a.crop(crop)).resize(size, Image.LANCZOS),
                             on_checker(r, sam_a.crop(crop)).resize(size, Image.LANCZOS)]))
    W = 3 * 366
    H = sum(t[1][0].height + 26 for t in tiles) + 24
    s = Image.new("RGB", (W, H), "white")
    dr = ImageDraw.Draw(s)
    for i, cap in enumerate(("правка", "текущий слой", "слой SAM")):
        dr.text((i * 366 + 4, 3), cap, fill="black", font=font)
    y = 24
    for stat, ims in tiles:
        dr.text((4, y + 3), f"{stat['layer']}  IoU {stat['iou']}  SAM +{stat['sam_adds']} -{stat['sam_drops']}",
                fill="#a01818", font=font)
        for i, im in enumerate(ims):
            s.paste(im, (i * 366, y + 24))
        y += ims[0].height + 26
    OUT.parent.mkdir(parents=True, exist_ok=True)
    for colors in (256, 128, 64):
        s.quantize(colors, dither=Image.Dither.FLOYDSTEINBERG).save(OUT, optimize=True)
        if OUT.stat().st_size <= MAX_BYTES:
            break
    print(f"{OUT} {OUT.stat().st_size / 2**20:.2f} МБ, {s.size}", flush=True)


if __name__ == "__main__":
    main()
