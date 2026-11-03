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
import time
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


def run_batch(settings: dict, model: str, kind: str, tasks: list[dict], dry: bool,
              progress=None) -> dict[str, Path]:
    """tasks: [{key, prompt, negative, seed, size}] -> {key: путь к сырому PNG}.
    progress(done, total, state) вызывается, пока ImageGen работает.

    Все задачи уходят одним вызовом generate(items=...), чтобы ImageGen
    загрузил модель один раз (для Qwen это особенно важно).
    """
    if not tasks:
        return {}
    out_dir = RAW / kind
    items = []
    # ImageGen обрезает имя файла до 6 слов / 48 символов, поэтому длинные ключи
    # (персонаж + наряд + поза) не годятся: даём короткие имена, а сопоставляем по порядку.
    for i, t in enumerate(tasks):
        item = {"prompt": t["prompt"], "name": f"{kind.replace('/', '_')}_{i:03d}", "count": 1, "seed": t["seed"], "size": t["size"]}
        if t.get("negative"):
            item["negative"] = t["negative"]
        items.append(item)

    if dry:
        DRY_DIR.mkdir(parents=True, exist_ok=True)
        p = DRY_DIR / f"imagegen_{kind}.json"
        p.write_text(json.dumps({"model": model, "out_dir": str(out_dir), "items": items,
                                 "keys": [t["key"] for t in tasks]},
                                ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Сухой прогон: {len(items)} шт. для ImageGen ({model}) -> {p.relative_to(ROOT)}")
        return {}

    jobs = _jobs(settings)
    # сырые файлы прошлых запусков не нужны (копии уже лежат в assets/), а с ними ImageGen допишет _2
    if out_dir.exists():
        for f in out_dir.glob("*.png"):
            f.unlink()
    timeout = int(settings["imagegen"].get("timeout", 1800))
    res = jobs.generate(out_dir=str(out_dir), model=model, items=items)
    deadline = time.time() + timeout
    st = {"files": res["files"], "state": "queued", "counts": {}}
    while True:
        st = jobs.status(res["job"])
        done = st["counts"].get("done", 0)
        if progress:
            progress(done, len(items), st["state"])
        if st["state"] not in ("queued", "running") or time.time() > deadline:
            break
        time.sleep(1.0)
    print(f"ImageGen: задание {res['job']}, состояние {st.get('state')}, {st.get('counts')}")
    out = {}
    for t, f in zip(tasks, res["files"]):
        f = Path(f["file"] if isinstance(f, dict) else f)
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
