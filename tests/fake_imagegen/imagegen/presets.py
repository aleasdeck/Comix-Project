"""Фейковые пресеты ImageGen для тестов comix (тот же интерфейс, что использует comix)."""
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class Preset:
    name: str
    title: str
    build: Callable


def klein_graph(p):
    return {
        "unet": {"class_type": "UNETLoader", "inputs": {}},
        "vae": {"class_type": "VAELoader", "inputs": {}},
        "release": {"class_type": "CLIPTextEncode", "inputs": {"text": p.prompt}},
        "guider": {"class_type": "CFGGuider", "inputs": {"positive": ["release", 0], "negative": ["release", 1]}},
    }


def qwen_graph(p):
    return klein_graph(p)


PRESETS = {"klein": Preset("klein", "klein", klein_graph), "qwen": Preset("qwen", "qwen", qwen_graph)}
