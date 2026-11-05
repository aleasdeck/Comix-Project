"""Проба SAM на всём слоте головы: 6 вещей, 20 поз, 120 слоёв. Боевая нарезка не меняется.

Что показала первая версия этого скрипта. Правило «SAM не должен брать неизменённое и терять
изменённое» оказалось неверным: чёрная маска на тёмных бровях и тёмная шляпа на тёмных волосах
почти не отличаются от базы, поэтому верная маска штрафовалась. Сырой SAM к тому же тащит в слой
голую кожу из прорезей и стёкол, а слои не перекрашиваются: на тёмной коже это светлые пятна.

Здесь гибрид: контур от SAM, из него вычитается голая кожа, убирается мелкий мусор.
Голая кожа = похожа на кожу в правке, кожа в базе и правка её почти не тронула, иначе красная
бандана с бликами получит дыры.

Итог пробы в docs/sam_probe/head_summary.md: автоматическое правило decide() НЕ годится для боевого
кода. Оно приняло 119 слоёв из 120, в том числе те, где гибрид закрывает глаза. Судить слой надо
на базе, а не отдельно: так и нарисован head.png.

Запускать питоном ComfyUI:
    C:\\Windows\\System32\\.venv\\Scripts\\python.exe scripts\\sam_head.py
Итог: docs/sam_probe/head.png, цифры в build/sam_head_stats.json.
"""
from __future__ import annotations

import json
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy import ndimage as ndi
from transformers import Sam2Model, Sam2Processor

from sam_probe import DOLL, MODEL, ROOT, cutout, dilate, erode, spread_points

OUT = ROOT / "docs" / "sam_probe" / "head.png"
STATS = ROOT / "build" / "sam_head_stats.json"
MAX_BYTES = 3 * 1024 * 1024
ITEMS = ["fedora", "baseball_cap", "beanie", "hero_mask", "bandana", "gas_mask"]
POSES = ["idle", "talk", "point", "walk", "shock", "cross", "think", "run", "fight", "victory"]
N_POS, N_NEG = 8, 6
BG = (58, 128, 128)  # бирюзовый: на нём видны и светлая кожа, и тёмные вещи


def skin_like(img: Image.Image) -> np.ndarray:
    """Как comix.doll._skin_like: тут своя копия, чтобы не тянуть настройки проекта."""
    hsv = np.asarray(img.convert("HSV"), dtype=np.float32) / 255.0
    hue, sat, val = hsv[..., 0] * 360, hsv[..., 1], hsv[..., 2]
    return ((hue <= 45) | (hue >= 345)) & (sat >= 0.12) & (sat <= 0.80) & (val >= 0.40)


def parts(m: np.ndarray) -> dict:
    area = max(1, int(m.sum()))
    lab, n = ndi.label(m)
    sizes = ndi.sum(m, lab, range(1, n + 1)) if n else np.array([0.0])
    hole = ndi.binary_fill_holes(m) & ~m
    hl, hn = ndi.label(hole)
    hs = ndi.sum(hole, hl, range(1, hn + 1)) if hn else np.array([])
    hs = hs[hs >= 16]
    edge = int((m & ~ndi.binary_erosion(m)).sum())
    return {"area": area, "main": round(float(sizes.max()) / area, 4), "pieces": int((sizes >= 6).sum()),
            "holes": int(len(hs)), "hole_share": round(float(hs.sum()) / area, 4), "rough": round(edge / area ** 0.5, 2)}


def refine(sam: np.ndarray, rgb: Image.Image, dist: np.ndarray, base_skin: np.ndarray) -> np.ndarray:
    """Контур SAM минус голая кожа, без мелкого мусора и без крапинок внутри."""
    m = sam & ~(skin_like(rgb) & base_skin & (dist < 60))
    lab, n = ndi.label(m)
    if n:
        sizes = ndi.sum(m, lab, range(1, n + 1))
        m = np.isin(lab, np.nonzero(sizes >= 0.005 * sizes.sum())[0] + 1)
    hole = ndi.binary_fill_holes(m) & ~m
    hl, hn = ndi.label(hole)
    if hn:
        hs = ndi.sum(hole, hl, range(1, hn + 1))
        m = m | np.isin(hl, np.nonzero(hs < 30)[0] + 1)
    return m


def decide(c: dict, s: dict, score: float) -> tuple[str, str]:
    """Правило для боевого кода: дешёвые проверки, что SAM не развалился. Качество края они не меряют."""
    ratio = s["area"] / max(1, c["area"])
    if score < 0.80:
        return "keep", "низкая уверенность"
    if s["main"] < 0.97:
        return "keep", "распался на куски"
    if not 0.75 <= ratio <= 1.7:
        return "keep", "площадь не та"
    if s["hole_share"] > c["hole_share"] + 0.03:
        return "keep", "дырявее"
    return "sam", "контур SAM"


def prompts(cur: np.ndarray, fig_base: np.ndarray):
    ys, xs = np.nonzero(cur)
    box = [float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())]
    inner = cur
    for r in (6, 4, 2):
        e = erode(cur, r)
        if e.sum() > 200:
            inner = e
            break
    pos = spread_points(inner, N_POS)
    near = np.zeros_like(cur)
    pad = 36
    near[max(0, int(box[1]) - pad):int(box[3]) + pad, max(0, int(box[0]) - pad):int(box[2]) + pad] = True
    # волосы и кожа рядом с вещью: у шляпы именно волосы главный соблазн для сегментатора
    neg_area = fig_base & ~dilate(cur, 7) & near
    neg = spread_points(erode(neg_area, 2), N_NEG) or spread_points(neg_area, N_NEG)
    return box, pos + neg, [1] * len(pos) + [0] * len(neg)


def main():
    if not torch.cuda.is_available():
        sys.exit("Нет видеокарты в torch: запускай питоном ComfyUI")
    proc = Sam2Processor.from_pretrained(MODEL, local_files_only=True)
    model = Sam2Model.from_pretrained(MODEL, local_files_only=True).to("cuda").eval()
    torch.cuda.reset_peak_memory_stats()
    rows, t0, sam_sec = [], time.time(), 0.0
    for it in ITEMS:
        for g in ("male", "female"):
            for pose in POSES:
                d = DOLL / g / pose
                layer = Image.open(d / f"head__{it}.png").convert("RGBA")
                rgb, cur_a = layer.convert("RGB"), layer.getchannel("A")
                cur = np.asarray(cur_a) > 128
                base = np.asarray(Image.open(d / "raw_base_light.png").convert("RGB"), dtype=np.int16)
                dist = np.abs(base - np.asarray(rgb, dtype=np.int16)).max(axis=-1)
                fig_base = np.asarray(Image.open(d / "base_light.png").convert("RGBA").getchannel("A")) > 128
                base_skin = np.asarray(Image.open(d / "skin_mask.png").convert("L")) > 128
                box, points, labels = prompts(cur, fig_base)
                t1 = time.time()
                inputs = proc(images=rgb, input_points=[[points]], input_labels=[[labels]], input_boxes=[[box]],
                              return_tensors="pt").to("cuda")
                with torch.no_grad():
                    out = model(**inputs, multimask_output=False)
                masks = proc.post_process_masks(out.pred_masks.cpu(), inputs["original_sizes"])[0]
                sam_sec += time.time() - t1
                raw = masks.reshape(-1, *masks.shape[-2:])[0].numpy() > 0
                raw &= np.asarray(cutout(rgb, "floodfill", 28).getchannel("A")) > 128
                sam = refine(raw, rgb, dist, base_skin)
                score = float(out.iou_scores.flatten()[0])
                iou = float((sam & cur).sum()) / max(1, int((sam | cur).sum()))
                c, s = parts(cur), parts(sam)
                verdict, why = decide(c, s, score)
                sam_a = Image.fromarray((sam * 255).astype("uint8")).filter(ImageFilter.GaussianBlur(1.0))
                rows.append({"item": it, "gender": g, "pose": pose, "iou": round(iou, 3), "score": round(score, 3),
                             "verdict": verdict, "why": why, "cur": c, "sam": s,
                             "skin_removed": round(float((raw & ~sam).sum()) / max(1, int(raw.sum())), 4),
                             "_img": (rgb, cur_a, sam_a, cur | sam, Image.open(d / "base_light.png").convert("RGBA"))})
        print(it, Counter(r["verdict"] for r in rows if r["item"] == it),
              "площадь:", round(float(np.mean([r["sam"]["area"] / r["cur"]["area"] for r in rows if r["item"] == it])), 2), flush=True)
    sec = time.time() - t0
    peak = torch.cuda.max_memory_allocated() / 2**30
    print(f"слоёв {len(rows)}, всего {sec:.0f} с, сам SAM {sam_sec / len(rows):.2f} с на слой, пик {peak:.2f} ГБ", flush=True)
    print("итог", Counter(r["verdict"] for r in rows), Counter(r["why"] for r in rows), flush=True)
    print("отказы:", [f"{r['gender'][0]}/{r['item']}/{r['pose']}: {r['why']}" for r in rows if r["verdict"] != "sam"], flush=True)
    sheet(rows)
    STATS.write_text(json.dumps({"peak_gb": round(peak, 2), "sam_sec_per_layer": round(sam_sec / len(rows), 2),
                                 "rows": [{k: v for k, v in r.items() if k != "_img"} for r in rows]},
                                ensure_ascii=False, indent=1), encoding="utf-8")


def tile(rgb, alpha, base, crop, w, h):
    """Слой на настоящей базе: только так видно, что заметит игрок. Сам по себе слой обманывает:
    дыры над бровями у маски лежат на тёмных бровях базы и незаметны."""
    im = base.copy()
    la = rgb.convert("RGBA")
    la.putalpha(alpha)
    im.alpha_composite(la)
    t = Image.new("RGB", im.size, BG)
    t.paste(im, mask=im.getchannel("A"))
    t = t.crop(crop)
    t.thumbnail((w, h), Image.LANCZOS)
    return t


def sheet(rows):
    font = ImageFont.truetype("arial.ttf", 12)
    tw, th, label = 150, 92, 84
    colors = {"sam": (20, 150, 60), "keep": (205, 60, 50)}
    groups = [(it, g) for it in ITEMS for g in ("male", "female")]
    W = label + len(POSES) * (tw + 6)
    rh = 2 * th + 22
    s = Image.new("RGB", (W, 22 + len(groups) * rh), "white")
    dr = ImageDraw.Draw(s)
    for i, p in enumerate(POSES):
        dr.text((label + i * (tw + 6) + 4, 4), p, fill="black", font=font)
    for gi, (it, g) in enumerate(groups):
        y = 22 + gi * rh
        dr.text((3, y + 6), f"{it}\n{g}\nверх: текущий\nниз: гибрид\nзелёный: взять\nкрасный: нет", fill="black", font=font)
        for i, p in enumerate(POSES):
            r = next(x for x in rows if x["item"] == it and x["gender"] == g and x["pose"] == p)
            rgb, cur_a, sam_a, union, base_img = r["_img"]
            ys, xs = np.nonzero(union)
            pad = 14
            crop = (max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad),
                    min(rgb.width, int(xs.max()) + pad), min(rgb.height, int(ys.max()) + pad))
            x = label + i * (tw + 6)
            s.paste(tile(rgb, cur_a, base_img, crop, tw, th), (x + 2, y + 2))
            s.paste(tile(rgb, sam_a, base_img, crop, tw, th), (x + 2, y + th + 4))
            dr.rectangle((x, y, x + tw + 3, y + 2 * th + 6), outline=colors[r["verdict"]], width=2)
            dr.text((x + 4, y + 2 * th + 7), f"{r['iou']:.2f} {r['score']:.2f}", fill=colors[r["verdict"]], font=font)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    for n in (256, 128, 64):
        s.quantize(n, dither=Image.Dither.FLOYDSTEINBERG).save(OUT, optimize=True)
        if OUT.stat().st_size <= MAX_BYTES:
            break
    print(f"{OUT} {OUT.stat().st_size / 2**20:.2f} МБ, {s.size}", flush=True)


if __name__ == "__main__":
    main()
