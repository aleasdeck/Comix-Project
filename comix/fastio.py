"""Быстрая пересборка: пропуск неизменившегося и параллельная работа на всех ядрах.

Pillow и numpy отпускают GIL в тяжёлых местах (resize, кодирование webp, большинство операций
над массивами), поэтому обычных потоков хватает и не нужны отдельные процессы.
"""
from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Iterable

# method=4: те же размеры файлов, что и у method=6 (проверено на слоях куклы), но в десятки раз быстрее
WEBP_METHOD = 4


def fresh(dst: Path, *srcs: Path) -> bool:
    """dst уже есть и не старее ни одного из srcs: пересобирать не нужно."""
    if not dst.exists():
        return False
    t = dst.stat().st_mtime
    return all(not s.exists() or s.stat().st_mtime <= t for s in srcs)


def pmap(fn: Callable, items: Iterable) -> list:
    """map на всех ядрах; первая ошибка поднимается как обычно."""
    items = list(items)
    if len(items) < 2:
        return [fn(x) for x in items]
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as ex:
        return list(ex.map(fn, items))
