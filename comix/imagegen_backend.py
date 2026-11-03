"""Генерация через локальный ImageGen (D:\\VibeProjects\\ImageGen).

ImageGen сам поднимает ComfyUI, держит очередь, выбирает графы моделей и
закрывает ComfyUI после простоя. Мы только отдаём ему пачку промптов
(`jobs.generate(items=...)`) и забираем готовые PNG.

Пресеты ImageGen: klein / klein-fast (FLUX.2 klein 4B), zimage (Z-Image Turbo),
qwen / qwen-fast (Qwen-Image-2512). ControlNet там нет, поэтому поза задаётся
текстом промпта.
"""

from __future__ import annotations

import importlib
import json
import shutil
import sys
from pathlib import Path

from .config import ROOT

RAW = ROOT / "build" / "imagegen_raw"
DRY_DIR = ROOT / "build" / "dry_run"


def _jobs(settings: dict):
    path = Path(settings["imagegen"]["path"])
    if not (path / "imagegen" / "jobs.py").exists():
        sys.exit(f"Не найден ImageGen в {path}. Поправь imagegen.path в config/settings.yaml.")
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))
    return importlib.import_module("imagegen.jobs")


def run_batch(settings: dict, model: str, kind: str, tasks: list[dict], dry: bool) -> dict[str, Path]:
    """tasks: [{key, prompt, negative, seed, size}] -> {key: путь к сырому PNG}.

    Все задачи уходят одним вызовом generate(items=...), чтобы ImageGen
    загрузил модель один раз (для Qwen это особенно важно).
    """
    if not tasks:
        return {}
    out_dir = RAW / kind
    items = []
    for t in tasks:
        item = {"prompt": t["prompt"], "name": t["key"], "count": 1, "seed": t["seed"], "size": t["size"]}
        if t.get("negative"):
            item["negative"] = t["negative"]
        items.append(item)

    if dry:
        DRY_DIR.mkdir(parents=True, exist_ok=True)
        p = DRY_DIR / f"imagegen_{kind}.json"
        p.write_text(json.dumps({"model": model, "out_dir": str(out_dir), "items": items},
                                ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Сухой прогон: {len(items)} шт. для ImageGen ({model}) -> {p.relative_to(ROOT)}")
        return {}

    jobs = _jobs(settings)
    # старые сырые файлы с теми же именами мешают: ImageGen тогда допишет _2
    for t in tasks:
        f = out_dir / f"{t['key']}_{t['seed']}.png"
        if f.exists():
            f.unlink()
    timeout = int(settings["imagegen"].get("timeout", 1800))
    res = jobs.generate(out_dir=str(out_dir), model=model, items=items, wait=True, timeout=timeout)
    print(f"ImageGen: задание {res['job']}, состояние {res.get('state')}, {res.get('counts')}")
    out = {}
    for t, f in zip(tasks, res["files"]):
        f = Path(f)
        if f.exists():
            out[t["key"]] = f
        else:
            print(f"  не готово: {t['key']} ({f.name})")
    return out


def server_stop(settings: dict, when: str = "idle"):
    try:
        _jobs(settings).server(action="stop", when=when)
    except Exception as e:  # остановка — подстраховка, не повод падать
        print(f"Не удалось остановить ComfyUI: {e}")


def models(settings: dict) -> list[dict]:
    return _jobs(settings).models()


def copy(src: Path, dst: Path):
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
