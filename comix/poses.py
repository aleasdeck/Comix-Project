"""Десять универсальных комикс-поз (план поз: 10 поз-действий, эмоции отдельным слоем лица).

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
        "title": "Испуг, отпрянул",
        "prompt": "recoiling back in fright, leaning back, both hands raised in front of the chest with palms out, legs slightly apart",
        "points": _pose(p3=(0.355, 0.320), p4=(0.395, 0.215),
                        p6=(0.645, 0.320), p7=(0.605, 0.215),
                        p0=(0.505, 0.150), p14=(0.487, 0.135), p15=(0.523, 0.135),
                        p9=(0.425, 0.680), p10=(0.405, 0.865),
                        p12=(0.575, 0.680), p13=(0.595, 0.865)),
    },
    "cross": {
        "title": "Руки скрещены",
        "prompt": "standing with arms crossed over the chest, confident, facing the viewer",
        "points": _pose(p3=(0.395, 0.335), p4=(0.570, 0.305),
                        p6=(0.605, 0.335), p7=(0.430, 0.315)),
    },
    "think": {
        "title": "Думает, рука у подбородка",
        "prompt": "thinking, one hand raised to the chin, the other arm folded across the stomach supporting the elbow, facing the viewer",
        "points": _pose(p3=(0.420, 0.335), p4=(0.485, 0.190),
                        p6=(0.590, 0.350), p7=(0.445, 0.350)),
    },
    "run": {
        "title": "Бежит",
        "prompt": "running fast toward the viewer, mid-stride, one knee raised high, arms bent and pumping, leaning forward",
        "points": _pose(p0=(0.495, 0.155), p14=(0.477, 0.140), p15=(0.513, 0.140),
                        p3=(0.360, 0.320), p4=(0.395, 0.240),
                        p6=(0.650, 0.335), p7=(0.680, 0.430),
                        p9=(0.425, 0.630), p10=(0.400, 0.790),
                        p12=(0.585, 0.690), p13=(0.640, 0.850)),
    },
    "fight": {
        "title": "Боевая стойка, удар",
        "prompt": "throwing a straight punch to the side with one arm fully extended, the other fist raised guarding the chin, wide fighting stance",
        "points": _pose(p3=(0.320, 0.250), p4=(0.225, 0.245),
                        p6=(0.625, 0.320), p7=(0.570, 0.215),
                        p9=(0.405, 0.680), p10=(0.355, 0.865),
                        p12=(0.600, 0.680), p13=(0.650, 0.865)),
    },
    "victory": {
        "title": "Победа, кулак вверх",
        "prompt": "celebrating victory, one fist raised high above the head, the other hand in a fist at the hip, big confident grin",
        "points": _pose(p3=(0.370, 0.150), p4=(0.385, 0.055),
                        p6=(0.640, 0.340), p7=(0.590, 0.440)),
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
