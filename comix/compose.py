"""Сборка страницы комикса из сценария (YAML) на 3–5 кадров."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from . import bubbles, placeholder
from .config import CharacterShot, Project, background_path, load_yaml, make_shot
from .cutout import trim

# Раскладки: прямоугольники кадров (x0, y0, x1, y1) в долях рабочей области страницы.
LAYOUTS = {
    "3a": [(0, 0, 1, .40), (0, .40, .5, 1), (.5, .40, 1, 1)],
    "3b": [(0, 0, 1, 1 / 3), (0, 1 / 3, 1, 2 / 3), (0, 2 / 3, 1, 1)],
    "3c": [(0, 0, .55, .5), (.55, 0, 1, .5), (0, .5, 1, 1)],
    "4a": [(0, 0, .5, .5), (.5, 0, 1, .5), (0, .5, .5, 1), (.5, .5, 1, 1)],
    "4b": [(0, 0, 1, .30), (0, .30, .5, .65), (.5, .30, 1, .65), (0, .65, 1, 1)],
    "4c": [(0, 0, .6, .5), (.6, 0, 1, .5), (0, .5, .4, 1), (.4, .5, 1, 1)],
    "5a": [(0, 0, .5, .33), (.5, 0, 1, .33), (0, .33, 1, .66), (0, .66, .5, 1), (.5, .66, 1, 1)],
    "5b": [(0, 0, 1, .28), (0, .28, .4, .64), (.4, .28, 1, .64), (0, .64, .6, 1), (.6, .64, 1, 1)],
}
DEFAULT_LAYOUT = {3: "3a", 4: "4b", 5: "5a"}


@dataclass
class Missing:
    kind: str
    what: str


def panel_rects(layout: str, page_size, margin: int, gutter: int):
    W, H = page_size
    x0, y0 = margin - gutter / 2, margin - gutter / 2
    cw, ch = W - 2 * x0, H - 2 * y0
    out = []
    for a, b, c, d in LAYOUTS[layout]:
        out.append((int(x0 + a * cw + gutter / 2), int(y0 + b * ch + gutter / 2),
                    int(x0 + c * cw - gutter / 2), int(y0 + d * ch - gutter / 2)))
    return out


def parse_bg(ref: str, project: Project) -> tuple[str, str]:
    loc, _, var = ref.partition("/")
    if loc not in project.backgrounds:
        raise KeyError(f"Нет локации '{loc}' в config/backgrounds.yaml")
    var = var or next(iter(project.variations))
    if var not in project.variations:
        raise KeyError(f"Нет вариации '{var}' в config/backgrounds.yaml")
    return loc, var


def plan(project: Project, script: dict) -> tuple[list[CharacterShot], list[tuple[str, str]]]:
    """Какие картинки нужны для сценария (для команды generate)."""
    shots, bgs = [], []
    for p in script["panels"]:
        if p.get("background"):
            bg = parse_bg(p["background"], project)
            if bg not in bgs:
                bgs.append(bg)
        for c in p.get("characters", []):
            s = make_shot(project, c["id"], c.get("pose", "idle"), c.get("outfit"))
            if s not in shots:
                shots.append(s)
    return shots, bgs


def _cover(img: Image.Image, size, zoom: float = 1.0, focus=(0.5, 0.5)) -> Image.Image:
    w, h = size
    scale = max(w / img.width, h / img.height) * zoom
    img = img.resize((max(w, int(img.width * scale)), max(h, int(img.height * scale))), Image.LANCZOS)
    fx, fy = focus
    left = int((img.width - w) * fx)
    top = int((img.height - h) * fy)
    return img.crop((left, top, left + w, top + h))


def _char_image(project: Project, shot: CharacterShot, missing: list) -> Image.Image:
    if shot.path.exists():
        return Image.open(shot.path).convert("RGBA")
    missing.append(Missing("персонаж", str(shot.path)))
    return trim(placeholder.character(project, shot))


def _bg_image(project: Project, loc: str, var: str, missing: list) -> Image.Image:
    p = background_path(loc, var)
    if p.exists():
        return Image.open(p).convert("RGB")
    missing.append(Missing("фон", str(p)))
    return placeholder.background(project, loc, var)


def render_panel(project: Project, spec: dict, size, missing: list, font) -> tuple[Image.Image, dict]:
    w, h = size
    if spec.get("background"):
        loc, var = parse_bg(spec["background"], project)
        panel = _cover(_bg_image(project, loc, var, missing), size,
                       spec.get("zoom", 1.0), tuple(spec.get("focus", (0.5, 0.5)))).convert("RGBA")
    else:
        panel = Image.new("RGBA", size, spec.get("color", "#ffffff"))

    heads = {}
    for c in spec.get("characters", []):
        shot = make_shot(project, c["id"], c.get("pose", "idle"), c.get("outfit"))
        img = _char_image(project, shot, missing)
        if c.get("flip"):
            img = ImageOps.mirror(img)
        ch = int(h * c.get("height", 0.85))
        img = img.resize((max(1, int(img.width * ch / img.height)), ch), Image.LANCZOS)
        cx = int(w * c.get("x", 0.5))
        by = int(h * c.get("y", 1.0))
        panel.paste(img, (cx - img.width // 2, by - img.height), img)
        heads[c["id"]] = (cx, by - img.height + int(img.height * 0.08))
    return panel, heads


def compose(project: Project, script: dict) -> tuple[Image.Image, list[Missing]]:
    ps = project.settings["page"]
    panels = script["panels"]
    if not 1 <= len(panels) <= 5:
        raise ValueError("На странице должно быть от 1 до 5 кадров")
    layout = script.get("layout", "auto")
    if layout == "auto":
        layout = DEFAULT_LAYOUT.get(len(panels), "3b")
    rects = panel_rects(layout, ps["size"], ps["margin"], ps["gutter"])
    if len(rects) != len(panels):
        raise ValueError(f"Раскладка {layout} рассчитана на {len(rects)} кадров, а в сценарии {len(panels)}")

    fonts = project.settings["fonts"]
    font = bubbles.load_font(tuple(fonts["bubble"]), int(script.get("font_size", fonts.get("bubble_size", 34))))

    page = Image.new("RGBA", tuple(ps["size"]), ps.get("background", "#ffffff"))
    d = ImageDraw.Draw(page)
    missing: list[Missing] = []
    pending_bubbles = []
    for spec, (x0, y0, x1, y1) in zip(panels, rects):
        size = (x1 - x0, y1 - y0)
        img, heads = render_panel(project, spec, size, missing, font)
        page.alpha_composite(img, (x0, y0))
        d.rectangle([x0, y0, x1, y1], outline=(0, 0, 0), width=ps.get("border", 6))
        for b in spec.get("bubbles", []):
            pending_bubbles.append((b, (x0, y0, x1, y1), heads))

    # облачка поверх рамок, чтобы могли на них заходить
    for b, (x0, y0, x1, y1), heads in pending_bubbles:
        pw, ph = x1 - x0, y1 - y0
        bx, by = x0 + pw * b.get("x", 0.5), y0 + ph * b.get("y", 0.15)
        tail = None
        target = b.get("tail_to")
        if isinstance(target, str) and target in heads:
            tx, ty = x0 + heads[target][0], y0 + heads[target][1]
        elif isinstance(target, (list, tuple)):
            tx, ty = x0 + pw * target[0], y0 + ph * target[1]
        else:
            tx = None
        if tx is not None:
            # голова может быть за кадром (крупный план) — держим хвостик внутри кадра
            tx = min(max(tx, x0 + pw * 0.05), x1 - pw * 0.05)
            ty = min(max(ty, y0 + ph * 0.05), y1 - ph * 0.05)
            tail = ((tx - bx) * 0.8, (ty - by) * 0.8)
        f = font.font_variant(size=int(font.size * b.get("scale", 1.0)))
        img, (cx, cy) = bubbles.render(b.get("kind", "speech"), b.get("text", ""), f,
                                       max_text_width=int(pw * b.get("width", 0.42)), tail=tail)
        page.paste(img, (int(bx - cx), int(by - cy)), img)
    return page.convert("RGB"), missing


def compose_file(project: Project, script_path: Path, out_path: Path) -> list[Missing]:
    script = load_yaml(script_path)
    page, missing = compose(project, script)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    page.save(out_path)
    return missing
