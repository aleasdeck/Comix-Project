"""Пять универсальных комикс-поз.

Каждая поза задана скелетом OpenPose (18 точек COCO) в нормированных
координатах кадра (0..1) и текстовым описанием для промпта.
Скелет рендерится в PNG и подаётся в ControlNet OpenPose, чтобы все
персонажи стояли в одинаковых позах при любой одежде.

Порядок точек: 0 нос, 1 шея, 2 пр.плечо, 3 пр.локоть, 4 пр.кисть,
5 лев.плечо, 6 лев.локоть, 7 лев.кисть, 8 пр.бедро, 9 пр.колено,
10 пр.щиколотка, 11 лев.бедро, 12 лев.колено, 13 лев.щиколотка,
14 пр.глаз, 15 лев.глаз, 16 пр.ухо, 17 лев.ухо.
"Правое" — правое для персонажа, на картинке оно слева (персонаж смотрит на нас).
"""

from __future__ import annotations

from PIL import Image, ImageDraw

# Базовая стойка, от неё строятся остальные позы.
_BASE = {
    0: (0.500, 0.145), 1: (0.500, 0.225),
    2: (0.405, 0.235), 3: (0.380, 0.360), 4: (0.370, 0.480),
    5: (0.595, 0.235), 6: (0.620, 0.360), 7: (0.630, 0.480),
    8: (0.445, 0.500), 9: (0.445, 0.680), 10: (0.445, 0.865),
    11: (0.555, 0.500), 12: (0.555, 0.680), 13: (0.555, 0.865),
    14: (0.482, 0.130), 15: (0.518, 0.130), 16: (0.462, 0.140), 17: (0.538, 0.140),
}


def _pose(**overrides):
    pts = dict(_BASE)
    for k, v in overrides.items():
        pts[int(k[1:])] = v
    return pts


POSES = {
    "idle": {
        "title": "Стоит спокойно",
        "prompt": "standing straight in a relaxed neutral pose, arms down at the sides, facing the viewer",
        "points": _pose(),
    },
    "talk": {
        "title": "Говорит, жестикулирует",
        "prompt": "talking and gesturing with one open hand raised at chest level, other arm relaxed, facing the viewer",
        "points": _pose(p6=(0.670, 0.330), p7=(0.700, 0.245)),
    },
    "point": {
        "title": "Указывает в сторону",
        "prompt": "pointing to the side with an outstretched arm and index finger, looking where pointing",
        "points": _pose(p3=(0.300, 0.240), p4=(0.200, 0.235),
                        p0=(0.488, 0.145), p14=(0.470, 0.130), p15=(0.505, 0.130)),
    },
    "walk": {
        "title": "Идёт",
        "prompt": "walking forward mid-stride, arms swinging naturally",
        "points": _pose(p9=(0.415, 0.675), p10=(0.370, 0.860),
                        p12=(0.580, 0.670), p13=(0.620, 0.850),
                        p3=(0.395, 0.355), p4=(0.430, 0.465),
                        p6=(0.635, 0.355), p7=(0.600, 0.460)),
    },
    "shock": {
        "title": "Шок / удивление",
        "prompt": "shocked and surprised, both hands raised up near the head, mouth open, legs slightly apart",
        "points": _pose(p3=(0.330, 0.160), p4=(0.355, 0.070),
                        p6=(0.670, 0.160), p7=(0.645, 0.070),
                        p9=(0.425, 0.680), p10=(0.405, 0.865),
                        p12=(0.575, 0.680), p13=(0.595, 0.865)),
    },
}

# Пары точек и цвета, как в стандартном рендере OpenPose (body_18).
LIMBS = [
    (1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10),
    (1, 11), (11, 12), (12, 13), (1, 0), (0, 14), (14, 16), (0, 15), (15, 17),
]
COLORS = [
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0),
    (85, 255, 0), (0, 255, 0), (0, 255, 85), (0, 255, 170), (0, 255, 255),
    (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255), (170, 0, 255),
    (255, 0, 255), (255, 0, 170), (255, 0, 85),
]


def render_openpose(pose_id: str, size: tuple[int, int]) -> Image.Image:
    """Скелет позы в стиле OpenPose на чёрном фоне (для ControlNet)."""
    w, h = size
    pts = {k: (x * w, y * h) for k, (x, y) in POSES[pose_id]["points"].items()}
    img = Image.new("RGB", size, (0, 0, 0))
    d = ImageDraw.Draw(img)
    stick = max(4, int(w * 0.012))
    for i, (a, b) in enumerate(LIMBS):
        d.line([pts[a], pts[b]], fill=tuple(int(c * 0.6) for c in COLORS[i]), width=stick)
    r = max(3, int(w * 0.006))
    for i in range(18):
        x, y = pts[i]
        d.ellipse([x - r, y - r, x + r, y + r], fill=COLORS[i])
    return img
