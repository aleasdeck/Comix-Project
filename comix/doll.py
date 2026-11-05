"""«Бумажная кукла»: заранее сгенерированные слои, из которых собирается персонаж.

Чтобы слои совпадали, все картинки одного пола выводятся из одной базовой:
  1. база: человек в простой одежде-«подложке», поза idle (текст -> картинка, klein);
  2. остальные позы: редактирование базы idle («та же персона, другая поза»);
  3. цвета кожи: редактирование базы каждой позы («смени цвет кожи, остальное не трогай»);
  4. каждая вещь: редактирование базы позы («надень красную кепку, остальное не трогай»),
     потом из разницы с базой вырезается слой только этой вещи.
Редактирование идёт через FLUX.2 klein с картинкой-образцом (ReferenceLatent). ImageGen
такого пресета не имеет, поэтому comix регистрирует у себя «klein-edit» поверх klein
(те же веса, ComfyUI не перезагружается) и не меняет сам ImageGen.

Результат: assets/doll/<пол>/<поза>/base_<кожа>.png и <слот>__<вещь>.png одного размера,
плюс assets/doll/manifest.json. Страница собирает персонажа, накладывая PNG друг на друга.

Ночная фабрика (comix night) добавляет:
  * базы 10 поз: несколько вариантов на позу (скелет позы вторым референсом и без него),
    лучший выбирается автоматически по совпадению силуэта со скелетом и цвету головы;
    все варианты лежат в <поза>/candidates/, выбор можно поменять: comix doll pick;
  * слой лица face__<эмоция>.png (эмоции) и face__npc_<id>.png (лица и причёски NPC),
    к нему маска кожи *_skin.png для перекраски и маска *_erase.png: что стереть с базы
    (например длинные волосы базы под короткой стрижкой NPC);
  * автопроверку: если правка задела фигуру вне своего слота, вещь один раз
    перегенерируется с другим сидом и берётся лучший вариант (qa.json в папке позы).
"""

from __future__ import annotations

import dataclasses
import importlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from . import imagegen_backend as ig
from .config import ASSETS, SLOTS, Project
from .cutout import cutout
from .poses import LIMBS, POSES, render_openpose

DOLL = ASSETS / "doll"
LAYER_ORDER = ("shoes", "bottom", "top", "head")  # снизу вверх, поверх тела
GENDER_WORD = {"male": "man", "female": "woman"}

# «подложка»: в чём кукла, когда слот пустой
UNDERWEAR = "a plain white tank top and plain light blue shorts, barefoot"
HAIR = {"male": "short dark brown hair", "female": "shoulder-length dark brown hair"}
KEEP = ("Keep exactly the same person, face, hairstyle, body proportions, pose, camera framing, "
        "position in the image and the plain light grey background. Change nothing else.")

# В какой полосе фигуры (доля высоты от макушки до пяток) может лежать слой слота
BANDS = {"head": (-0.08, 0.24), "top": (0.10, 0.85), "bottom": (0.40, 0.95), "shoes": (0.80, 1.06)}

SLOT_VERB = {
    "head": "Put {item} on the person's head",
    "top": "Dress the person's upper body in {item}, replacing the tank top",
    "bottom": "Dress the person's legs in {item}, replacing the shorts",
    "shoes": "Put {item} on the person's feet",
}
MASK_VERB = "Put {item} on the person's face"


def _style(project: Project) -> str:
    return project.settings["style"]["character"]


def base_prompt(project: Project, gender: str, skin: str) -> str:
    sk = project.skin_tones[skin]["prompt"]
    return ", ".join([
        f"full body shot of a single young adult {GENDER_WORD[gender]}",
        POSES["idle"]["prompt"],
        f"wearing {UNDERWEAR}", sk, HAIR[gender], "neutral friendly expression",
        "whole figure visible from head to toes with empty space above the head and below the feet, centered",
        "isolated on a plain flat light grey background, no shadows on the background",
        _style(project),
    ])


def pose_prompt(pose: str) -> str:
    return f"Change only the pose: the person is now {POSES[pose]['prompt']}. " + KEEP


def pose_ref_prompt(pose: str) -> str:
    """Поза по скелету: картинка 1 — персонаж, картинка 2 — скелет OpenPose (правила BFL: нумеровать картинки)."""
    return (f"Image 1 shows the character, image 2 is a stick-figure pose guide. Redraw exactly the same person "
            f"from image 1, now {POSES[pose]['prompt']}, matching the pose of the stick figure in image 2. "
            f"Same face, hairstyle, body proportions, white tank top, light blue shorts and bare feet. "
            f"Whole figure from head to toes, same size and position in the frame, the same plain light grey "
            f"background, the same comic style. Do not draw the stick figure.")


def emotion_prompt(expr: str) -> str:
    return (f"Change only the facial expression: the person now has {expr}. Keep exactly the same face shape, "
            f"hairstyle, head angle, body, pose, clothing, camera framing and the plain light grey background. "
            f"Change nothing else.")


def npc_face_prompt(desc: str) -> str:
    return (f"Change only the person's head: make them {desc}. Change the face, age and hairstyle. Keep exactly "
            f"the same body, pose, head position and angle, white tank top, light blue shorts, camera framing and "
            f"the plain light grey background. Change nothing below the neck.")


def skin_prompt(project: Project, skin: str) -> str:
    return f"Change only the skin tone of the person to {project.skin_tones[skin]['prompt']}. " + KEEP


def item_prompt(project: Project, slot: str, item_id: str) -> str:
    it = project.item(slot, item_id)
    verb = MASK_VERB if it.get("kind") == "mask" else SLOT_VERB[slot]
    return verb.format(item=it["prompt"]) + ". " + KEEP


# --- ImageGen: пресет редактирования поверх klein ------------------------------

def _register_edit(settings: dict, ref: Path, *more: Path) -> str:
    return ig.register_edit(settings, [ref, *more])


def _run(project: Project, model: str, kind: str, tasks: list[dict]) -> dict[str, Path]:
    w, h = project.settings["sizes"]["character"]
    for t in tasks:
        t.setdefault("size", f"{w}x{h}")
        t.setdefault("negative", "blurry, deformed, extra limbs, text, watermark, background scenery, cropped")
    return ig.run_batch(project.settings, model, kind, tasks, dry=False,
                        progress=lambda d, n, st: print(f"\r  {kind}: {d}/{n} {st}   ", end="", flush=True))


# --- обработка картинок -------------------------------------------------------

def _shift(ref: np.ndarray, img: np.ndarray, max_shift: int = 40) -> tuple[int, int]:
    """Сдвиг img относительно ref (фазовая корреляция по серому, целые пиксели)."""
    a = ref.mean(axis=-1)
    b = img.mean(axis=-1)
    a = a - a.mean()
    b = b - b.mean()
    r = np.fft.ifft2(np.fft.fft2(a) * np.conj(np.fft.fft2(b)))
    r = np.abs(r)
    dy, dx = np.unravel_index(np.argmax(r), r.shape)
    h, w = a.shape
    dy = dy - h if dy > h // 2 else dy
    dx = dx - w if dx > w // 2 else dx
    if abs(dx) > max_shift or abs(dy) > max_shift:
        return 0, 0
    return int(dx), int(dy)


def _align(base: Image.Image, img: Image.Image) -> Image.Image:
    a = np.asarray(base.convert("RGB"), dtype=np.float32)
    b = np.asarray(img.convert("RGB").resize(base.size), dtype=np.float32)
    dx, dy = _shift(a, b)
    if dx or dy:
        img = img.convert("RGB").resize(base.size).transform(base.size, Image.AFFINE, (1, 0, -dx, 0, 1, -dy),
                                                            fillcolor=tuple(int(v) for v in a[0, 0]))
    return img.convert("RGB").resize(base.size)


_ALPHA_CACHE: dict[str, np.ndarray] = {}


def _ed_alpha(project: Project, img: Image.Image) -> np.ndarray:
    """Маска фигуры после правки (заливка фона). Кэш: одну картинку режут и нарезка, и автопроверка."""
    import hashlib

    key = hashlib.md5(img.tobytes()).hexdigest()
    if key not in _ALPHA_CACHE:
        if len(_ALPHA_CACHE) > 64:
            _ALPHA_CACHE.clear()
        cut = project.settings.get("cutout", {})
        _ALPHA_CACHE[key] = np.asarray(cutout(img, "floodfill", cut.get("tolerance", 28)).getchannel("A")) > 128
    return _ALPHA_CACHE[key]


def _figure_rows(alpha: np.ndarray) -> tuple[int, int]:
    rows = np.where(alpha.max(axis=1) > 128)[0]
    return (int(rows[0]), int(rows[-1])) if len(rows) else (0, alpha.shape[0] - 1)


def skin_mask(base: Image.Image) -> tuple[Image.Image, list[int]]:
    """Маска кожи на базовой картинке по цвету + опорный цвет кожи (медиана).

    Кожа: тёплый оттенок (красный..жёлтый), средняя насыщенность, не тёмная.
    Майка (белая), шорты (голубые), тёмные волосы и контуры сюда не попадают.
    """
    rgba = base.convert("RGBA")
    hsv = np.asarray(rgba.convert("RGB").convert("HSV"), dtype=np.float32) / 255.0
    alpha = np.asarray(rgba.getchannel("A")) > 128
    hue, sat, val = hsv[..., 0] * 360, hsv[..., 1], hsv[..., 2]
    m = alpha & ((hue <= 45) | (hue >= 345)) & (sat >= 0.12) & (sat <= 0.80) & (val >= 0.40)
    img = Image.fromarray((m * 255).astype("uint8"))
    img = img.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(0.7))
    rgb = np.asarray(rgba.convert("RGB"))[m]
    ref = [int(v) for v in np.median(rgb, axis=0)] if len(rgb) else [234, 195, 162]
    return img, ref


def recolor(base: Image.Image, mask: Image.Image, ref: list[int], target: str) -> Image.Image:
    """То же, что делает страница: кожа -> целевой цвет с сохранением светотени."""
    t = np.array([int(target.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)
    a = np.asarray(base.convert("RGBA"), dtype=np.float32)
    lum = a[..., :3] @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    ref_l = float(np.dot(ref, [0.299, 0.587, 0.114])) or 1.0
    new = np.clip(t[None, None, :] * (lum / ref_l)[..., None], 0, 255)
    m = (np.asarray(mask, dtype=np.float32) / 255.0)[..., None]
    out = a.copy()
    out[..., :3] = a[..., :3] * (1 - m) + new * m
    return Image.fromarray(out.astype("uint8"), "RGBA")


def _skin_like(img: Image.Image) -> np.ndarray:
    hsv = np.asarray(img.convert("RGB").convert("HSV"), dtype=np.float32) / 255.0
    hue, sat, val = hsv[..., 0] * 360, hsv[..., 1], hsv[..., 2]
    return ((hue <= 45) | (hue >= 345)) & (sat >= 0.12) & (sat <= 0.80) & (val >= 0.40)


def _morph(mask: np.ndarray, r: int, op) -> np.ndarray:
    """Быстрая бинарная дилатация (op=logical_or) / эрозия (logical_and) квадратом 2r+1.
    Сдвиги по осям без заворачивания: за краем картинки считается фон."""
    out = mask
    for axis in (0, 1):
        acc = out.copy()
        for k in range(1, r + 1):
            for sh in (k, -k):
                rolled = np.roll(out, sh, axis=axis)
                idx = [slice(None), slice(None)]
                idx[axis] = slice(0, sh) if sh > 0 else slice(sh, None)
                rolled[tuple(idx)] = False
                acc = op(acc, rolled)
        out = acc
    return out


def _close(mask: np.ndarray, r: int) -> np.ndarray:
    return _morph(_morph(mask, r, np.logical_or), r, np.logical_and)


def _fill_holes(m: Image.Image) -> Image.Image:
    """Залить области, не связанные с краем картинки (дырки внутри маски)."""
    w, h = m.size
    big = Image.new("L", (w + 2, h + 2), 0)
    big.paste(m.point(lambda v: 255 if v > 128 else 0), (1, 1))
    ImageDraw.floodfill(big, (0, 0), 128)
    a = np.asarray(big)[1:-1, 1:-1]
    return Image.fromarray(np.where(a == 128, 0, 255).astype("uint8"))


def underwear_mask(base: Image.Image) -> Image.Image:
    """Голубые шорты базы: страница закрашивает их кожей, когда надет низ (узкие штаны их не перекрывают)."""
    rgba = base.convert("RGBA")
    hsv = np.asarray(rgba.convert("RGB").convert("HSV"), dtype=np.float32) / 255.0
    alpha = np.asarray(rgba.getchannel("A")) > 128
    hue, sat, val = hsv[..., 0] * 360, hsv[..., 1], hsv[..., 2]
    m = alpha & (hue >= 180) & (hue <= 240) & (sat >= 0.2) & (val >= 0.45)
    img = Image.fromarray((m * 255).astype("uint8")).filter(ImageFilter.MaxFilter(3))
    return img.filter(ImageFilter.GaussianBlur(0.7))


def extract_layer(project: Project, base_rgb: Image.Image, base_alpha: np.ndarray, edited: Image.Image,
                  slot: str, threshold: int = 42, item_id: str = "") -> Image.Image:
    """Слой вещи = пиксели, которые редактирование заметно поменяло, в полосе своего слота."""
    edited = _align(base_rgb, edited)
    a = np.asarray(base_rgb, dtype=np.int16)
    b = np.asarray(edited, dtype=np.int16)
    dist = np.abs(a - b).max(axis=-1)
    if slot in ("top", "bottom"):
        # бежевый тренч почти не отличается от светлой кожи, поэтому для одежды порог низкий,
        # но не ниже «дрожания» правки: его меряем на лице, которое такая правка не трогает
        top_r, bot_r = _figure_rows(base_alpha)
        face = np.zeros_like(dist, dtype=bool)
        face[top_r:int(top_r + 0.12 * (bot_r - top_r)), :] = True
        skin = np.asarray(skin_mask(Image.fromarray(np.dstack([a.astype("uint8"),
                                                                 base_alpha.astype("uint8")]), "RGBA"))[0]) > 128
        sample = dist[face & skin]
        threshold = int(np.clip(np.percentile(sample, 90) + 8 if sample.size > 200 else 18, 14, threshold))
    diff = dist > threshold

    # то, что после правки стало фоном, — не вещь
    ed_alpha = _ed_alpha(project, edited)
    mask = diff & ed_alpha

    top, bottom = _figure_rows(base_alpha)
    fh = bottom - top
    lo, hi = BANDS[slot]
    band = np.zeros_like(mask)
    band[max(0, int(top + lo * fh)):min(mask.shape[0], int(top + hi * fh)), :] = True
    mask &= band

    # голова/обувь: то, что после правки осталось кожей (тень под полями шляпы), — не вещь
    if slot in ("head", "shoes"):
        mask &= ~_skin_like(edited)

    mask = _morph(_morph(mask, 1, np.logical_and), 1, np.logical_or)  # убрать одиночный шум
    mask = _close(mask, 7)                                              # закрыть щели (бежевое ≈ кожа)
    m = _fill_holes(Image.fromarray((mask * 255).astype("uint8")))     # дырки внутри силуэта вещи
    final = (np.asarray(m) > 128) & ed_alpha & band
    if slot in ("top", "bottom"):
        # руки/ноги, которые правка лишь чуть перерисовала: в базе это кожа, и в правке цвет кожи
        # (тот же оттенок, что у опорной кожи; бежевый тренч желтее и сюда не попадает)
        base_rgba = Image.fromarray(np.dstack([a.astype("uint8"), base_alpha.astype("uint8")]), "RGBA")
        bskin_img, ref = skin_mask(base_rgba)
        bskin = np.asarray(bskin_img) > 128
        hsv = np.asarray(edited.convert("HSV"), dtype=np.float32) / 255.0
        r_hsv = np.asarray(Image.new("RGB", (1, 1), tuple(ref)).convert("HSV"), dtype=np.float32)[0, 0] / 255.0
        dh = np.abs(hsv[..., 0] - r_hsv[0]) * 360
        dh = np.minimum(dh, 360 - dh)
        same_skin = bskin & _skin_like(edited) & (dh < 6) & (np.abs(hsv[..., 1] - r_hsv[1]) < 0.10)
        final &= ~same_skin
        if slot == "top":
            # шорты базы между полами плаща: в правке там всё ещё голубое
            shorts = np.asarray(underwear_mask(base_rgba)) > 128
            ed_shorts = np.asarray(underwear_mask(edited.convert("RGBA"))) > 128
            final &= ~(shorts & (ed_shorts | (dist < 42)))
        # убрать мелкие крапинки и залить дырки внутри вещи, которые эти правила могли проколоть
        final = _morph(_morph(final, 1, np.logical_and), 1, np.logical_or)
        final = (np.asarray(_fill_holes(Image.fromarray((final * 255).astype("uint8")))) > 128) & ed_alpha & band
    if slot == "head" and project.item(slot, item_id).get("kind") == "mask":
        # в прорезях маски — лицо базы, а не перерисованная кожа
        final &= ~(_skin_like(edited) | (dist < 42))
    m = Image.fromarray((final * 255).astype("uint8"))
    m = m.filter(ImageFilter.GaussianBlur(1.0))
    layer = edited.convert("RGBA")
    layer.putalpha(m)
    return layer


# --- слой лица: эмоции и лица NPC -------------------------------------------------

FACE_BANDS = {"emotion": (-0.06, 0.20), "npc": (-0.14, 0.36)}
# строки фигуры (доля высоты), которые правка слота трогать не должна: для автопроверки
PROTECTED = {"head": [(0.34, 1.0)], "top": [(0.0, 0.07), (0.93, 1.0)], "bottom": [(0.0, 0.34)],
             "shoes": [(0.0, 0.74)], "emotion": [(0.26, 1.0)], "npc": [(0.42, 1.0)]}
SPILL_LIMIT = 0.02  # доля площади фигуры, изменённая вне слота


def _jitter_threshold(dist: np.ndarray, base_alpha: np.ndarray, rows: tuple[float, float],
                      lo: int = 12, hi: int = 40) -> int:
    """Порог «правка заметно поменяла пиксель»: выше дрожания на нетронутой части фигуры."""
    top, bot = _figure_rows(base_alpha)
    fh = bot - top
    zone = np.zeros_like(dist, dtype=bool)
    zone[int(top + rows[0] * fh):int(top + rows[1] * fh), :] = True
    sample = dist[zone & (base_alpha > 128)]
    return int(np.clip(np.percentile(sample, 90) + 8, lo, hi)) if sample.size > 200 else 24


def extract_face(project: Project, base_rgb: Image.Image, base_alpha: np.ndarray, edited: Image.Image,
                 kind: str) -> tuple[Image.Image, Image.Image, Image.Image]:
    """Слой лица (эмоция или лицо NPC) + маска «стереть с базы» + маска кожи слоя для перекраски."""
    edited = _align(base_rgb, edited)
    a = np.asarray(base_rgb, dtype=np.int16)
    b = np.asarray(edited, dtype=np.int16)
    dist = np.abs(a - b).max(axis=-1)
    thr = _jitter_threshold(dist, base_alpha, (0.45, 0.70))  # дрожание на торсе, который правка не трогает
    ed_alpha = _ed_alpha(project, edited)

    top, bottom = _figure_rows(base_alpha)
    fh = bottom - top
    lo, hi = FACE_BANDS[kind]
    band = np.zeros_like(ed_alpha)
    band[max(0, int(top + lo * fh)):min(band.shape[0], int(top + hi * fh)), :] = True

    mask = (dist > thr) & ed_alpha & band
    mask = _morph(_morph(mask, 1, np.logical_and), 1, np.logical_or)
    mask = _close(mask, 4 if kind == "emotion" else 7)
    mask = np.asarray(_fill_holes(Image.fromarray((mask * 255).astype("uint8")))) > 128
    mask = _morph(mask, 2, np.logical_or)  # немного кожи вокруг: край слоя не виден
    final = mask & ed_alpha & band
    m = Image.fromarray((final * 255).astype("uint8")).filter(ImageFilter.GaussianBlur(1.2))
    layer = edited.convert("RGBA")
    layer.putalpha(m)

    erase = (base_alpha > 128) & ~ed_alpha & band
    erase = _morph(erase, 1, np.logical_or) if kind == "npc" else np.zeros_like(erase)
    skin = skin_mask(layer)[0]
    return layer, Image.fromarray((erase * 255).astype("uint8")), skin


def edit_spill(project: Project, base_rgb: Image.Image, base_alpha: np.ndarray, edited: Image.Image,
               zone: str) -> float:
    """Доля площади фигуры, которую правка заметно поменяла там, где её слот не лежит."""
    edited = _align(base_rgb, edited)
    dist = np.abs(np.asarray(base_rgb, dtype=np.int16) - np.asarray(edited, dtype=np.int16)).max(axis=-1)
    ed_alpha = _ed_alpha(project, edited)
    fig = base_alpha > 128
    area = max(1, int(fig.sum()))
    top, bottom = _figure_rows(base_alpha)
    fh = bottom - top
    rows = np.zeros_like(fig)
    for lo, hi in PROTECTED[zone]:
        rows[max(0, int(top + lo * fh)):min(fig.shape[0], int(top + hi * fh) + 1), :] = True
    changed = (dist > 60) | (fig != ed_alpha)
    changed = _morph(_morph(changed, 1, np.logical_and), 1, np.logical_or)  # без одиночных пикселей
    return float((changed & (fig | ed_alpha) & rows).sum()) / area


# --- базы поз: скелет, варианты, автовыбор ---------------------------------------

def _fit(points: dict, alpha: np.ndarray) -> dict:
    """Точки скелета (доли кадра) -> пиксели, вписанные в фигуру базы «стоит».
    Опора — стойка idle: макушка ~0.07, ступни ~0.89 высоты кадра."""
    h, w = alpha.shape
    top, bot = _figure_rows(alpha)
    cols = np.where(alpha.max(axis=0) > 128)[0]
    cx = float(cols.mean()) if len(cols) else w / 2
    k = (bot - top) / ((0.89 - 0.07) * h)
    return {i: (cx + (x * w - 0.5 * w) * k, top + (y * h - 0.07 * h) * k) for i, (x, y) in points.items()}


def skeleton_image(gender: str, pose: str, idle_alpha: np.ndarray) -> Path:
    """Скелет позы, вписанный в фигуру базы этого пола, PNG того же размера, что база."""
    h, w = idle_alpha.shape
    out = DOLL / gender / "_skeletons" / f"{pose}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    pts = _fit(POSES[pose]["points"], idle_alpha)
    # render_openpose рисует по долям кадра: переводим пиксели обратно в доли
    saved = POSES[pose]["points"]
    POSES[pose]["points"] = {i: (x / w, y / h) for i, (x, y) in pts.items()}
    try:
        render_openpose(pose, (w, h)).save(out)
    finally:
        POSES[pose]["points"] = saved
    return out


def pose_score(project: Project, gender: str, pose: str, cand: Image.Image, idle: Image.Image) -> dict:
    """Насколько вариант базы похож на нужную позу и на того же человека. Больше — лучше."""
    cut = project.settings.get("cutout", {})
    small = (idle.width // 2, idle.height // 2)
    idle_a = np.asarray(cutout(idle.convert("RGB").resize(small), "floodfill", cut.get("tolerance", 28))
                        .getchannel("A")) > 128
    rgba = cutout(cand.convert("RGB").resize(small), "floodfill", cut.get("tolerance", 28))
    alpha = np.asarray(rgba.getchannel("A")) > 128
    h, w = alpha.shape
    pts = _fit(POSES[pose]["points"], (idle_a * 255).astype("uint8"))
    top, bot = _figure_rows((idle_a * 255).astype("uint8"))
    fh = max(1, bot - top)

    # Смотрим только на те части скелета, которые в этой позе сдвинулись относительно «стоит»:
    # конечность там, где надо (moved), и не осталась там, где была в «стоит» (stale).
    idle_pts = _fit(POSES["idle"]["points"], (idle_a * 255).astype("uint8"))
    near = _morph(alpha, max(3, int(0.03 * fh)), np.logical_or)
    moved, stale = [], []
    for a_, b_ in [(2, 3), (3, 4), (5, 6), (6, 7), (8, 9), (9, 10), (11, 12), (12, 13)]:
        for t in np.linspace(0.25, 1.0, 7):
            px = pts[a_][0] + (pts[b_][0] - pts[a_][0]) * t
            py = pts[a_][1] + (pts[b_][1] - pts[a_][1]) * t
            qx = idle_pts[a_][0] + (idle_pts[b_][0] - idle_pts[a_][0]) * t
            qy = idle_pts[a_][1] + (idle_pts[b_][1] - idle_pts[a_][1]) * t
            if np.hypot(px - qx, py - qy) < 0.06 * fh:
                continue
            x, y = int(px), int(py)
            moved.append(bool(0 <= x < w and 0 <= y < h and near[y, x]))
            x, y = int(qx), int(qy)
            stale.append(bool(0 <= x < w and 0 <= y < h and alpha[y, x]))
    coverage = float(np.mean(moved)) if moved else 1.0
    stale_f = float(np.mean(stale)) if stale else 0.0

    env = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(env)
    for a_, b_ in LIMBS[:12]:
        d.line([pts[a_], pts[b_]], fill=255, width=max(4, int(0.17 * fh)))
    hx, hy = pts[0]
    r = 0.11 * fh
    d.ellipse([hx - r, hy - 1.3 * r, hx + r, hy + 0.8 * r], fill=255)
    extra = float((alpha & ~(np.asarray(env) > 128)).sum()) / max(1, int(alpha.sum()))

    cropped = bool(alpha[0].any() or alpha[-1].any() or alpha[:, 0].any() or alpha[:, -1].any())

    def head_color(img: Image.Image, a: np.ndarray) -> np.ndarray:
        t, b = _figure_rows((a * 255).astype("uint8"))
        rows = slice(t, t + max(1, int(0.12 * (b - t))))
        px = np.asarray(img.convert("RGB").resize(small))[rows][a[rows]]
        return px.mean(axis=0) if len(px) else np.zeros(3)

    color = float(np.abs(head_color(cand, alpha) - head_color(idle, idle_a)).mean())
    score = coverage - 0.5 * stale_f - 0.6 * extra - 0.004 * color - (0.3 if cropped else 0.0)
    return {"score": round(score, 4), "coverage": round(coverage, 3), "stale": round(stale_f, 3),
            "extra": round(extra, 3),
            "head_color": round(color, 1), "cropped": cropped}


def pose_bases(project: Project, gender: str, poses: list[str], n_candidates: int = 3,
               skin: str = "light") -> dict:
    """Варианты базы каждой позы и автовыбор лучшего -> <поза>/raw_base_<кожа>.png."""
    s = project.settings
    seed = int(s.get("doll", {}).get("seed", 7777))
    idle_raw = _paths(gender, "idle") / f"raw_base_{skin}.png"
    if not idle_raw.exists():
        ensure_idle_base(project, gender, skin)
    idle = Image.open(idle_raw).convert("RGB")
    cut = s.get("cutout", {})
    idle_alpha = np.asarray(cutout(idle, "floodfill", cut.get("tolerance", 28)).getchannel("A"))
    todo = [p for p in poses if p != "idle" and not (_paths(gender, p) / f"raw_base_{skin}.png").exists()]
    n_skel = max(1, n_candidates - 1)
    report = {}

    def cand_path(pose, k):
        return _paths(gender, pose) / "candidates" / f"raw_base_{skin}_c{k}.png"

    # 1) по скелету: своя пачка на позу (скелет — вторая опорная картинка)
    for pose in todo:
        need = [k for k in range(n_skel) if not cand_path(pose, k).exists()]
        if not need:
            continue
        skel = skeleton_image(gender, pose, idle_alpha)
        model = _register_edit(s, idle_raw, skel)
        raw = _run(project, model, f"doll/{gender}_{pose}_cand",
                   [{"key": str(k), "prompt": pose_ref_prompt(pose), "seed": seed + 101 * (k + 1)} for k in need])
        print()
        for k, f in raw.items():
            cand_path(pose, int(k)).parent.mkdir(parents=True, exist_ok=True)
            Image.open(f).convert("RGB").save(cand_path(pose, int(k)))
    # 2) только текстом: одна пачка на все позы
    if n_candidates > 1:
        k = n_candidates - 1
        need = [p for p in todo if not cand_path(p, k).exists()]
        if need:
            model = _register_edit(s, idle_raw)
            raw = _run(project, model, f"doll/{gender}_poses_text",
                       [{"key": p, "prompt": pose_prompt(p), "seed": seed} for p in need])
            print()
            for p, f in raw.items():
                cand_path(p, k).parent.mkdir(parents=True, exist_ok=True)
                Image.open(f).convert("RGB").save(cand_path(p, k))
    # 3) автовыбор
    for pose in todo:
        files = sorted((_paths(gender, pose) / "candidates").glob(f"raw_base_{skin}_c*.png"))
        if not files:
            print(f"[{gender}/{pose}] нет ни одного варианта базы")
            continue
        scores = {f.stem.rsplit("_c", 1)[1]: pose_score(project, gender, pose, Image.open(f), idle) for f in files}
        best = max(scores, key=lambda k: scores[k]["score"])
        pick(gender, pose, int(best), skin, scores=scores, auto=True)
        report[pose] = {"best": int(best), "scores": scores}
        print(f"[{gender}/{pose}] выбран вариант {best}: " +
              ", ".join(f"c{k}={v['score']}" for k, v in sorted(scores.items())))
    return report


def pick(gender: str, pose: str, candidate: int, skin: str = "light", scores: dict | None = None,
         auto: bool = False):
    """Сделать вариант базы основным. Слои, нарисованные на прошлой базе, убираются в old/."""
    d = _paths(gender, pose)
    src = d / "candidates" / f"raw_base_{skin}_c{candidate}.png"
    if not src.exists():
        raise SystemExit(f"Нет варианта {src}")
    dst = d / f"raw_base_{skin}.png"
    if dst.exists() and not auto:
        old = d / "old"
        old.mkdir(exist_ok=True)
        for f in list(d.glob("raw_*__*.png")) + list(d.glob("*__*.png")) + [dst]:
            if f.exists():
                f.replace(old / f.name)
    Image.open(src).save(dst)
    info_path = d / "candidates" / "pick.json"
    info = json.loads(info_path.read_text()) if info_path.exists() else {}
    if scores:
        info["scores"] = scores
    info.update({"picked": candidate, "auto": auto})
    info_path.write_text(json.dumps(info, ensure_ascii=False, indent=1))


def ensure_idle_base(project: Project, gender: str, skin: str = "light"):
    s = project.settings
    seed = int(s.get("doll", {}).get("seed", 7777))
    idle_dir = _paths(gender, "idle")
    idle_raw = idle_dir / f"raw_base_{skin}.png"
    if idle_raw.exists():
        return idle_raw
    print(f"[{gender}] база idle")
    raw = _run(project, s["imagegen"].get("character_model", "klein"), f"doll/{gender}_base",
               [{"key": "base", "prompt": base_prompt(project, gender, skin), "seed": seed}])
    print()
    if "base" not in raw:
        raise RuntimeError(f"ImageGen не вернул базу idle для {gender}")
    idle_dir.mkdir(parents=True, exist_ok=True)
    Image.open(raw["base"]).convert("RGB").save(idle_raw)
    return idle_raw


# --- слои на готовых базах: вещи, эмоции, лица NPC ---------------------------------

def _all_layer_jobs(project: Project, gender: str, pose: str, items: dict[str, list[str]] | None,
                    emotions: dict[str, str] | None, npc: dict[str, str] | None) -> list[dict]:
    d = _paths(gender, pose)
    seed = int(project.settings.get("doll", {}).get("seed", 7777))
    jobs = []
    for slot in SLOTS:
        for it in (items or {}).get(slot, []):
            if it != "none":
                jobs.append({"key": f"item:{slot}:{it}", "prompt": item_prompt(project, slot, it), "seed": seed,
                             "raw": d / f"raw_{slot}__{it}.png", "zone": slot})
    for eid, expr in (emotions or {}).items():
        jobs.append({"key": f"face:{eid}", "prompt": emotion_prompt(expr), "seed": seed,
                     "raw": d / f"raw_face__{eid}.png", "zone": "emotion"})
    for nid, desc in (npc or {}).items():
        jobs.append({"key": f"npc:{nid}", "prompt": npc_face_prompt(desc), "seed": seed,
                     "raw": d / f"raw_face__npc_{nid}.png", "zone": "npc"})
    return jobs


def layer_jobs(project: Project, gender: str, pose: str, items: dict[str, list[str]] | None = None,
               emotions: dict[str, str] | None = None, npc: dict[str, str] | None = None) -> list[dict]:
    """Каких сырых картинок слоёв ещё нет у этой позы: [{key, prompt, seed, raw, zone}]."""
    return [j for j in _all_layer_jobs(project, gender, pose, items, emotions, npc) if not j["raw"].exists()]


def run_layers(project: Project, gender: str, pose: str, jobs: list[dict], skin: str = "light") -> int:
    """Сгенерировать сырые картинки слоёв одной позы (одна пачка на базу)."""
    if not jobs:
        return 0
    d = _paths(gender, pose)
    base_raw = d / f"raw_base_{skin}.png"
    if not base_raw.exists():
        print(f"[{gender}/{pose}] нет базы, пропускаю {len(jobs)} слоёв")
        return 0
    model = _register_edit(project.settings, base_raw)
    raw = _run(project, model, f"doll/{gender}_{pose}",
               [{"key": j["key"], "prompt": j["prompt"], "seed": j["seed"]} for j in jobs])
    print()
    by_key = {j["key"]: j for j in jobs}
    for key, f in raw.items():
        Image.open(f).convert("RGB").save(by_key[key]["raw"])
    return len(raw)


def qa_pose(project: Project, gender: str, pose: str, skin: str = "light") -> dict:
    """Автопроверка всех сырых слоёв позы: доля фигуры, изменённая вне своего слота."""
    d = _paths(gender, pose)
    base_raw = d / f"raw_base_{skin}.png"
    if not base_raw.exists():
        return {}
    base_rgb = Image.open(base_raw).convert("RGB")
    cut = project.settings.get("cutout", {})
    base_alpha = np.asarray(cutout(base_rgb, "floodfill", cut.get("tolerance", 28)).getchannel("A"))
    qa_path = d / "qa.json"
    qa = json.loads(qa_path.read_text()) if qa_path.exists() else {}
    for f in sorted(d.glob("raw_*__*.png")):
        name = f.stem[4:]
        if name.endswith(("_try0", "_try1")):
            continue
        if name in qa and qa[name].get("file_mtime") == int(f.stat().st_mtime):
            continue
        slot = name.split("__", 1)[0]
        zone = "npc" if name.startswith("face__npc_") else ("emotion" if slot == "face" else slot)
        spill = edit_spill(project, base_rgb, base_alpha, Image.open(f), zone)
        qa[name] = {**qa.get(name, {}), "spill": round(spill, 4), "ok": spill <= SPILL_LIMIT,
                    "zone": zone, "file_mtime": int(f.stat().st_mtime)}
    qa_path.write_text(json.dumps(qa, ensure_ascii=False, indent=1))
    return qa


def bad_layers(project: Project, gender: str, pose: str, skin: str = "light") -> list[tuple[float, str]]:
    """[(spill, имя)] слоёв позы, не прошедших автопроверку и ещё не перегенерированных."""
    qa = qa_pose(project, gender, pose, skin)
    return [(v["spill"], n) for n, v in qa.items() if not v["ok"] and not v.get("retried")]


def retry_bad(project: Project, gender: str, pose: str, items: dict, emotions: dict, npc: dict,
              skin: str = "light", only: set | None = None) -> int:
    """Перегенерировать один раз с другим сидом то, что не прошло автопроверку, и взять лучшее."""
    d = _paths(gender, pose)
    qa = qa_pose(project, gender, pose, skin)
    bad = {n for n, v in qa.items() if not v["ok"] and not v.get("retried") and (only is None or n in only)}
    tmp = [{**j, "seed": j["seed"] + 7919, "raw": j["raw"].with_name(j["raw"].stem + "_try1.png"),
            "name": j["raw"].stem[4:]}
           for j in _all_layer_jobs(project, gender, pose, items, emotions, npc) if j["raw"].stem[4:] in bad]
    if not tmp:
        return 0
    print(f"[{gender}/{pose}] перегенерация {len(tmp)}: {', '.join(j['name'] for j in tmp)}")
    run_layers(project, gender, pose, tmp, skin)
    base_rgb = Image.open(d / f"raw_base_{skin}.png").convert("RGB")
    cut = project.settings.get("cutout", {})
    base_alpha = np.asarray(cutout(base_rgb, "floodfill", cut.get("tolerance", 28)).getchannel("A"))
    for j in tmp:
        name, cur = j["name"], d / f"raw_{j['name']}.png"
        if not j["raw"].exists():
            continue
        spill1 = edit_spill(project, base_rgb, base_alpha, Image.open(j["raw"]), j["zone"])
        if spill1 < qa[name]["spill"]:  # новый вариант лучше: старый уходит в _try0
            cur.replace(d / f"raw_{name}_try0.png")
            j["raw"].replace(cur)
        best = min(spill1, qa[name]["spill"])
        qa[name].update({"retried": True, "spill_retry": round(spill1, 4), "spill": round(best, 4),
                         "ok": best <= SPILL_LIMIT, "file_mtime": int(cur.stat().st_mtime)})
    (d / "qa.json").write_text(json.dumps(qa, ensure_ascii=False, indent=1))
    return len(tmp)


# --- сборка набора ------------------------------------------------------------

def _paths(gender: str, pose: str) -> Path:
    return DOLL / gender / pose


def build(project: Project, genders: list[str], poses: list[str], skins: list[str],
          items: dict[str, list[str]], force: bool = False):
    s = project.settings
    default_skin = skins[0]
    seed = int(s.get("doll", {}).get("seed", 7777))
    cut = s.get("cutout", {})

    for gender in genders:
        idle_dir = _paths(gender, "idle")
        idle_raw = idle_dir / f"raw_base_{default_skin}.png"
        # 1. база idle
        if force or not idle_raw.exists():
            print(f"[{gender}] база idle")
            raw = _run(project, s["imagegen"].get("character_model", "klein"), f"doll/{gender}_base",
                       [{"key": "base", "prompt": base_prompt(project, gender, default_skin), "seed": seed}])
            idle_dir.mkdir(parents=True, exist_ok=True)
            Image.open(raw["base"]).convert("RGB").save(idle_raw)
            print()

        # 2. остальные позы из idle
        todo = [p for p in poses if p != "idle" and (force or not (_paths(gender, p) / f"raw_base_{default_skin}.png").exists())]
        if todo:
            print(f"[{gender}] позы {todo}")
            model = _register_edit(s, idle_raw)
            raw = _run(project, model, f"doll/{gender}_poses",
                       [{"key": p, "prompt": pose_prompt(p), "seed": seed} for p in todo])
            for p, f in raw.items():
                _paths(gender, p).mkdir(parents=True, exist_ok=True)
                Image.open(f).convert("RGB").save(_paths(gender, p) / f"raw_base_{default_skin}.png")
            print()

        for pose in poses:
            d = _paths(gender, pose)
            base_raw_path = d / f"raw_base_{default_skin}.png"
            if not base_raw_path.exists():
                print(f"[{gender}/{pose}] нет базы, пропускаю")
                continue
            model = _register_edit(s, base_raw_path)

            # 3. кожа
            sk_todo = [k for k in skins[1:] if force or not (d / f"raw_base_{k}.png").exists()]
            # 4. вещи
            it_todo = [(slot, it) for slot in SLOTS for it in items.get(slot, [])
                       if it != "none" and (force or not (d / f"raw_{slot}__{it}.png").exists())]
            tasks = [{"key": f"skin:{k}", "prompt": skin_prompt(project, k), "seed": seed} for k in sk_todo]
            tasks += [{"key": f"item:{slot}:{it}", "prompt": item_prompt(project, slot, it), "seed": seed}
                      for slot, it in it_todo]
            if tasks:
                print(f"[{gender}/{pose}] кожа {len(sk_todo)}, вещи {len(it_todo)}")
                raw = _run(project, model, f"doll/{gender}_{pose}", tasks)
                print()
                for key, f in raw.items():
                    parts = key.split(":")
                    name = f"raw_base_{parts[1]}.png" if parts[0] == "skin" else f"raw_{parts[1]}__{parts[2]}.png"
                    Image.open(f).convert("RGB").save(d / name)

            process(project, gender, pose, skins, items, cut)
    write_manifest(project)


def process(project: Project, gender: str, pose: str, skins: list[str], items: dict[str, list[str]], cut: dict):
    """Сырые картинки -> прозрачные слои (можно перезапускать без генерации)."""
    d = _paths(gender, pose)
    base_raw = Image.open(d / f"raw_base_{skins[0]}.png").convert("RGB")
    for k in skins:
        p = d / f"raw_base_{k}.png"
        if p.exists():
            img = Image.open(p).convert("RGB") if k == skins[0] else _align(base_raw, Image.open(p))
            cutout(img, cut.get("method", "auto"), cut.get("tolerance", 28)).save(d / f"base_{k}.png")
    base_img = Image.open(d / f"base_{skins[0]}.png")
    mask, ref = skin_mask(base_img)
    mask.save(d / "skin_mask.png")
    underwear_mask(base_img).save(d / "shorts_mask.png")
    (d / "skin_ref.json").write_text(json.dumps(ref))
    base_alpha = np.asarray(base_img.getchannel("A"))
    for slot in SLOTS:
        for it in items.get(slot, []):
            p = d / f"raw_{slot}__{it}.png"
            if p.exists():
                extract_layer(project, base_raw, base_alpha, Image.open(p), slot, item_id=it).save(d / f"{slot}__{it}.png")
    process_faces(project, gender, pose, skins[0])


def process_faces(project: Project, gender: str, pose: str, skin: str = "light"):
    """Сырые эмоции и лица NPC -> face__<id>.png (+ _skin.png, _erase.png)."""
    d = _paths(gender, pose)
    if not (d / f"base_{skin}.png").exists():
        return
    base_raw = Image.open(d / f"raw_base_{skin}.png").convert("RGB")
    base_alpha = np.asarray(Image.open(d / f"base_{skin}.png").getchannel("A"))
    for f in sorted(d.glob("raw_face__*.png")):
        name = f.stem[4:]
        if name.endswith(("_try0", "_try1")):
            continue
        kind = "npc" if name.startswith("face__npc_") else "emotion"
        layer, erase, skin_m = extract_face(project, base_raw, base_alpha, Image.open(f), kind)
        layer.save(d / f"{name}.png")
        skin_m.save(d / f"{name}_skin.png")
        if kind == "npc":
            erase.save(d / f"{name}_erase.png")


def process_pose(project: Project, gender: str, pose: str, skin: str = "light"):
    """Пересобрать слои позы из всех сырых картинок, что есть (без генерации)."""
    d = _paths(gender, pose)
    if not (d / f"raw_base_{skin}.png").exists():
        return
    items = {slot: [k for k in (project.wardrobe.get(slot) or {}) if k != "none"] for slot in SLOTS}
    process(project, gender, pose, [skin], items, project.settings.get("cutout", {}))


def reprocess(project: Project):
    cut = project.settings.get("cutout", {})
    skins = list(project.skin_tones)
    items = {slot: [k for k in (project.wardrobe.get(slot) or {}) if k != "none"] for slot in SLOTS}
    for gdir in sorted(DOLL.glob("*")):
        if not gdir.is_dir():
            continue
        for pdir in sorted(gdir.glob("*")):
            # база — та, на которой рисовалась одежда (light); прочие сгенерированные кожи больше не нужны
            present = ["light"] if (pdir / "raw_base_light.png").exists() else \
                [k for k in skins if (pdir / f"raw_base_{k}.png").exists()][:1]
            if present:
                print(f"{gdir.name}/{pdir.name}")
                process(project, gdir.name, pdir.name, present, items, cut)
    write_manifest(project)


def write_manifest(project: Project):
    data = {"layer_order": list(LAYER_ORDER), "skins": {}, "items": {}, "poses": {}, "genders": {},
            "sets": project.wardrobe.get("sets") or {},
            # лицо рисуется поверх базы и под одеждой; erase стирает с базы то, что лицо NPC убрало
            "face_note": "base -> erase(face) -> face (recolor by face skin mask) -> layer_order"}
    for k, v in project.skin_tones.items():
        data["skins"][k] = v.get("color")
    for slot in SLOTS:
        data["items"][slot] = {k: v.get("prompt", "") for k, v in (project.wardrobe.get(slot) or {}).items()}
    data["poses"] = {k: v["title"] for k, v in POSES.items()}
    for gdir in sorted(p for p in DOLL.glob("*") if p.is_dir()):
        g = data["genders"][gdir.name] = {}
        for pdir in sorted(p for p in gdir.glob("*") if p.is_dir()):
            entry = {"base": {}, "layers": {s: {} for s in SLOTS}}
            if (pdir / "skin_mask.png").exists():
                entry["skin_mask"] = f"{gdir.name}/{pdir.name}/skin_mask.png"
                entry["skin_ref"] = json.loads((pdir / "skin_ref.json").read_text())
            if (pdir / "shorts_mask.png").exists():
                entry["shorts_mask"] = f"{gdir.name}/{pdir.name}/shorts_mask.png"
            for f in sorted(pdir.glob("base_*.png")):
                entry["base"][f.stem[5:]] = f"{gdir.name}/{pdir.name}/{f.name}"
            for f in sorted(pdir.glob("*__*.png")):
                if f.name.startswith("raw_") or f.stem.endswith(("_skin", "_erase", "_try0", "_try1", "_rgba")):
                    continue
                slot, it = f.stem.split("__", 1)
                rel = f"{gdir.name}/{pdir.name}/{f.name}"
                if slot == "face":
                    face = {"layer": rel}
                    for extra in ("skin", "erase"):
                        if (pdir / f"{f.stem}_{extra}.png").exists():
                            face[extra] = f"{gdir.name}/{pdir.name}/{f.stem}_{extra}.png"
                    entry.setdefault("faces", {})[it] = face
                    continue
                entry["layers"].setdefault(slot, {})[it] = rel
            if entry["base"]:
                g[pdir.name] = entry
    DOLL.mkdir(parents=True, exist_ok=True)
    (DOLL / "manifest.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return data


def _mask_rgba(src: Path) -> str:
    """Маска кладётся в альфу белой картинки: webp её хранит, а страница читает альфу."""
    m = Image.open(src).convert("L")
    img = Image.new("RGBA", m.size, (255, 255, 255, 0))
    img.putalpha(m)
    tmp = src.with_name(src.stem + "_rgba.png")
    img.save(tmp)
    return str(tmp.relative_to(DOLL)).replace("\\", "/")


def export(out_dir: Path, scale: float = 0.5, fmt: str = "webp"):
    """Уменьшенные копии слоёв для страницы-артефакта (+ manifest с новыми путями)."""
    data = json.loads((DOLL / "manifest.json").read_text(encoding="utf-8"))
    out_dir.mkdir(parents=True, exist_ok=True)

    def conv(rel: str) -> str:
        src = DOLL / rel
        dst_rel = str(Path(rel).with_suffix("." + fmt)).replace("\\", "/")
        dst = out_dir / dst_rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        img = Image.open(src).convert("RGBA")
        img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
        img.save(dst, quality=88, method=6) if fmt == "webp" else img.save(dst)
        return dst_rel

    for g in data["genders"].values():
        for entry in g.values():
            entry["base"] = {k: conv(v) for k, v in entry["base"].items()}
            entry["layers"] = {s: {k: conv(v) for k, v in d.items()} for s, d in entry["layers"].items()}
            for fid, face in (entry.get("faces") or {}).items():
                face["layer"] = conv(face["layer"])
                for key in ("skin", "erase"):
                    if face.get(key):
                        face[key] = conv(_mask_rgba(DOLL / face[key]))
            for key in ("skin_mask", "shorts_mask"):
                if entry.get(key):
                    entry[key] = conv(_mask_rgba(DOLL / entry[key]))
    (out_dir / "manifest.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Экспорт: {out_dir}")


def items_from_sets(project: Project, names: list[str] | None = None) -> dict[str, list[str]]:
    sets = project.wardrobe.get("sets") or {}
    out = {slot: [] for slot in SLOTS}
    for name, outfit in sets.items():
        if names and name not in names:
            continue
        for slot in SLOTS:
            it = outfit.get(slot)
            if it and it != "none" and it not in out[slot]:
                out[slot].append(it)
    return out
