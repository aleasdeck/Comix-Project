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
from .poses import POSES

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


def skin_prompt(project: Project, skin: str) -> str:
    return f"Change only the skin tone of the person to {project.skin_tones[skin]['prompt']}. " + KEEP


def item_prompt(project: Project, slot: str, item_id: str) -> str:
    it = project.item(slot, item_id)
    verb = MASK_VERB if it.get("kind") == "mask" else SLOT_VERB[slot]
    return verb.format(item=it["prompt"]) + ". " + KEEP


# --- ImageGen: пресет редактирования поверх klein ------------------------------

def _register_edit(settings: dict, ref: Path) -> str:
    ig._jobs(settings)  # добавляет ImageGen в sys.path
    presets = importlib.import_module("imagegen.presets")
    base = presets.PRESETS["klein"]

    def build(p):
        g = presets.klein_graph(p)
        g["ref"] = {"class_type": "ImageGenLoadImage", "inputs": {"path": str(ref)}}
        g["refenc"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["ref", 0], "vae": ["vae", 0]}}
        g["pref"] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["release", 0], "latent": ["refenc", 0]}}
        g["nref"] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["release", 1], "latent": ["refenc", 0]}}
        g["guider"]["inputs"]["positive"] = ["pref", 0]
        g["guider"]["inputs"]["negative"] = ["nref", 0]
        return g

    presets.PRESETS["klein-edit"] = dataclasses.replace(base, name="klein-edit", title="klein edit (comix doll)",
                                                       build=build)
    return "klein-edit"


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
    cut = project.settings.get("cutout", {})
    ed_alpha = np.asarray(cutout(edited, "floodfill", cut.get("tolerance", 28)).getchannel("A")) > 128
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
        # шорты базы, которые правка не тронула (между полами плаща)
        shorts = np.asarray(underwear_mask(base_rgba)) > 128
        final &= ~(same_skin | (shorts & (dist < 42)))
    if slot == "head" and project.item(slot, item_id).get("kind") == "mask":
        # в прорезях маски — лицо базы, а не перерисованная кожа
        final &= ~(_skin_like(edited) | (dist < 42))
    m = Image.fromarray((final * 255).astype("uint8"))
    m = m.filter(ImageFilter.GaussianBlur(1.0))
    layer = edited.convert("RGBA")
    layer.putalpha(m)
    return layer


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
            "sets": project.wardrobe.get("sets") or {}}
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
                if f.name.startswith("raw_"):
                    continue
                slot, it = f.stem.split("__", 1)
                entry["layers"].setdefault(slot, {})[it] = f"{gdir.name}/{pdir.name}/{f.name}"
            if entry["base"]:
                g[pdir.name] = entry
    DOLL.mkdir(parents=True, exist_ok=True)
    (DOLL / "manifest.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return data


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
            for key in ("skin_mask", "shorts_mask"):
                if entry.get(key):
                    # маска кладётся в альфу белой картинки: webp её хранит, а страница читает альфу
                    src = DOLL / entry[key]
                    m = Image.open(src).convert("L")
                    img = Image.new("RGBA", m.size, (255, 255, 255, 0))
                    img.putalpha(m)
                    tmp = src.with_name(src.stem + "_rgba.png")
                    img.save(tmp)
                    entry[key] = conv(str(tmp.relative_to(DOLL)).replace("\\", "/"))
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
