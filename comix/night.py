"""Ночная фабрика: одной командой сгенерировать всё, что нужно игре для одного мира.

    comix night --dry-run      что будет сделано и сколько примерно займёт
    comix night                запустить (можно прервать и запустить снова: готовое пропускается)
    comix night --only enemies stickers
    comix night --skip npc_faces

Что получается, описано в config/factory/<мир>.yaml. Лог: build/night/log.txt,
итог для просмотра утром: build/night/report.html.
Пока идёт генерация, Windows не уходит в сон (флаг снимается сам, когда процесс закончится).
"""

from __future__ import annotations

import html
import json
import sys
import time
import traceback
from pathlib import Path

from PIL import Image

from . import doll, sprites
from .config import CONFIG, ROOT, SLOTS, Project, background_path, load_yaml

NIGHT = ROOT / "build" / "night"
STAGES = ["hero_poses", "hero_sets", "hero_emotions", "world_items", "npc_faces", "hero_qa",
          "enemies", "bosses", "weapons", "props", "stickers", "backgrounds", "closeups",
          "hero_process", "game_export", "report"]
TITLES = {
    "hero_poses": "Герой: базы 10 поз (варианты и автовыбор)",
    "hero_sets": "Герой: 12 вещей трёх сетов во всех позах",
    "hero_emotions": "Герой: эмоции слоем лица",
    "world_items": "Лут мира: вещи во всех позах",
    "npc_faces": "Лица и причёски NPC",
    "hero_qa": "Автопроверка слоёв и одна перегенерация брака",
    "enemies": "Враги в 4 позах",
    "bosses": "Подручные и злодей в 4 позах",
    "weapons": "Битки (вещи в руку)",
    "props": "Сюжетные вещи",
    "stickers": "Наклейки",
    "backgrounds": "Фоны локаций",
    "closeups": "Крупные планы миниигр",
    "hero_process": "Нарезка слоёв, manifest и экспорт для страницы",
    "game_export": "Экспорт картинок в браузерную игру (game/public/assets)",
    "report": "Отчёт build/night/report.html",
}


class _Tee:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, data):
        for s in self.streams:
            try:
                s.write(data)
                s.flush()
            except Exception:
                pass

    def flush(self):
        for s in self.streams:
            try:
                s.flush()
            except Exception:
                pass


def _keep_awake():
    """Windows: не засыпать, пока идёт процесс (ES_CONTINUOUS | ES_SYSTEM_REQUIRED)."""
    if sys.platform != "win32":
        return
    try:
        import ctypes

        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001)
    except Exception as e:
        print(f"Не удалось запретить сон: {e}")


def load_factory(world: str) -> dict:
    """world: имя мира (config/factory/<мир>.yaml) или путь к своему yaml."""
    path = Path(world) if world.endswith((".yaml", ".yml")) else CONFIG / "factory" / f"{world}.yaml"
    if not path.exists():
        sys.exit(f"Нет {path}")
    return load_yaml(path)


# --- что осталось сделать --------------------------------------------------------------

def _hero(project: Project, f: dict):
    h = f.get("hero") or {}
    return h.get("genders", ["male", "female"]), h.get("poses", ["idle"])


def _set_items(project: Project, f: dict) -> dict:
    return doll.items_from_sets(project, (f.get("hero") or {}).get("sets"))


def _world_items(project: Project, f: dict) -> dict:
    extra = (f.get("hero") or {}).get("extra_items") or {}
    return {slot: list(extra.get(slot) or []) for slot in SLOTS}


def _npc(f: dict, gender: str) -> dict:
    return (f.get("npc_faces") or {}).get(gender) or {}


def _bg_list(project: Project, f: dict) -> list[tuple[str, str]]:
    out = []
    for loc in (f.get("backgrounds") or {}).get("locations", []):
        if loc not in project.backgrounds:
            print(f"  нет локации '{loc}' в config/backgrounds.yaml, пропускаю")
            continue
        for var in project.location_variations(loc):
            out.append((loc, var))
    return out


def todo(project: Project, f: dict, stage: str) -> tuple[int, str]:
    """(сколько картинок сгенерировать, какой моделью) для оценки времени."""
    genders, poses = _hero(project, f)
    n_cand = int((f.get("hero") or {}).get("pose_candidates", 3))
    if stage == "hero_poses":
        n = 0
        for g in genders:
            if not (doll._paths(g, "idle") / "raw_base_light.png").exists():
                n += 1
            for p in poses:
                if p != "idle" and not (doll._paths(g, p) / "raw_base_light.png").exists():
                    cands = doll._paths(g, p) / "candidates"
                    n += sum(1 for k in range(n_cand) if not (cands / f"raw_base_light_c{k}.png").exists())
        return n, "klein_edit"
    if stage in ("hero_sets", "hero_emotions", "world_items", "npc_faces"):
        n = 0
        for g in genders:
            for p in poses:
                n += len(_stage_jobs(project, f, stage, g, p))
        return n, "klein_edit"
    if stage == "hero_qa":
        # заранее не известно: оцениваем в 12% от всех слоёв героя
        n = sum(todo(project, f, s)[0] for s in ("hero_sets", "hero_emotions", "world_items", "npc_faces"))
        return min(int(n * 0.12), int((f.get("hero") or {}).get("qa_retry_max", 80))), "klein_edit"
    if stage in ("enemies", "bosses"):
        return len(sprites.creature_jobs(f.get(stage) or {}, f.get("creature_poses") or {})), "klein_edit"
    if stage in ("weapons", "props", "stickers"):
        return len(sprites.sprite_jobs(stage, f.get(stage) or {})), "klein"
    if stage == "backgrounds":
        return sum(1 for b in _bg_list(project, f) if not background_path(*b).exists()), "qwen"
    if stage == "closeups":
        return len(sprites.closeup_jobs(f.get("closeups") or {})), "qwen"
    return 0, "cpu"


def _stage_jobs(project: Project, f: dict, stage: str, gender: str, pose: str) -> list[dict]:
    h = f.get("hero") or {}
    if stage == "hero_sets":
        return doll.layer_jobs(project, gender, pose, items=_set_items(project, f))
    if stage == "world_items":
        return doll.layer_jobs(project, gender, pose, items=_world_items(project, f))
    if stage == "hero_emotions":
        return doll.layer_jobs(project, gender, pose, emotions=h.get("emotions") or {})
    if stage == "npc_faces":
        return doll.layer_jobs(project, gender, pose, npc=_npc(f, gender))
    return []


# --- стадии ------------------------------------------------------------------------------

def run_stage(project: Project, f: dict, stage: str) -> int:
    genders, poses = _hero(project, f)
    h = f.get("hero") or {}
    if stage == "hero_poses":
        report = {}
        for g in genders:
            doll.ensure_idle_base(project, g)
            report[g] = doll.pose_bases(project, g, poses, int(h.get("pose_candidates", 3)))
        (NIGHT / "pose_pick.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
        return sum(len(v) for v in report.values())
    if stage in ("hero_sets", "hero_emotions", "world_items", "npc_faces"):
        n = 0
        for g in genders:
            for p in poses:
                n += doll.run_layers(project, g, p, _stage_jobs(project, f, stage, g, p))
        return n
    if stage == "hero_qa":
        if not h.get("qa_retry", True):
            return 0
        items = {s: _set_items(project, f)[s] + _world_items(project, f)[s] for s in SLOTS}
        # перегенерируем не больше qa_retry_max самых плохих, чтобы ночь не растянулась
        bad = sorted(((sp, g, p, name) for g in genders for p in poses
                      for sp, name in doll.bad_layers(project, g, p)), reverse=True)
        cap = int(h.get("qa_retry_max", 80))
        print(f"  автопроверка: брак {len(bad)}, перегенерирую {min(cap, len(bad))}")
        chosen: dict[tuple, set] = {}
        for sp, g, p, name in bad[:cap]:
            chosen.setdefault((g, p), set()).add(name)
        n = 0
        for (g, p), names in chosen.items():
            n += doll.retry_bad(project, g, p, items, h.get("emotions") or {}, _npc(f, g), only=names)
        return n
    if stage in ("enemies", "bosses"):
        return sprites.creatures(project, f.get(stage) or {}, f.get("creature_poses") or {})
    if stage in ("weapons", "props", "stickers"):
        return sprites.sprites(project, stage, f.get(stage) or {}, sticker=(stage == "stickers"))
    if stage == "backgrounds":
        from .generate import generate_backgrounds

        return len(generate_backgrounds(project, _bg_list(project, f), dry=False))
    if stage == "closeups":
        return sprites.closeups(project, f.get("closeups") or {})
    if stage == "hero_process":
        n = 0
        for g in genders:
            for p in poses:
                if (doll._paths(g, p) / "raw_base_light.png").exists():
                    k = doll.process_pose(project, g, p, force=False)
                    print(f"  нарезка {g}/{p}: слоёв пересобрано {k}")
                    doll.qa_pose(project, g, p)
                    n += 1
        doll.write_manifest(project)
        doll.export(ROOT / "web" / "doll", 0.5)
        return n
    if stage == "game_export":
        from .game_export import export_game

        export_game(project, world=f.get("world", "city"))
        return 1
    if stage == "report":
        make_report(project, f)
        return 1
    raise KeyError(stage)


def plan(project: Project, f: dict, stages: list[str]) -> float:
    sec = f.get("seconds") or {"klein_edit": 20, "klein": 15, "qwen": 30}
    total = 0.0
    print(f"Мир «{f.get('title', f.get('world'))}». Что осталось сгенерировать:")
    for st in stages:
        n, kind = todo(project, f, st)
        t = n * float(sec.get(kind, 0))
        total += t
        est = f"~{t / 60:.0f} мин" if n else ""
        print(f"  {st:14} {n:5} шт. {kind:10} {est:10} {TITLES[st]}")
    print(f"Итого примерно {total / 3600:.1f} ч генерации (плюс автопроверка и нарезка слоёв на процессоре, ~1 ч).")
    return total


def run(project: Project, world: str = "city", only: list[str] | None = None, skip: list[str] | None = None,
        dry: bool = False):
    f = load_factory(world)
    stages = [s for s in STAGES if (not only or s in only) and s not in (skip or [])]
    if dry:
        plan(project, f, stages)
        return
    NIGHT.mkdir(parents=True, exist_ok=True)
    log = open(NIGHT / "log.txt", "a", encoding="utf-8")
    sys.stdout = _Tee(sys.__stdout__, log)
    sys.stderr = _Tee(sys.__stderr__, log)
    _keep_awake()
    status_path = NIGHT / "status.json"
    status = json.loads(status_path.read_text(encoding="utf-8")) if status_path.exists() else {}
    print(f"\n===== comix night {time.strftime('%Y-%m-%d %H:%M:%S')}, мир {world}, стадии: {', '.join(stages)}")
    plan(project, f, stages)
    started = time.time()
    try:
        for st in stages:
            t0 = time.time()
            print(f"\n--- {st}: {TITLES[st]} ({time.strftime('%H:%M:%S')})")
            try:
                n = run_stage(project, f, st)
                left, _ = todo(project, f, st)
                state = "ok" if not left or st in ("hero_qa", "hero_process", "game_export", "report") else "partial"
                status[st] = {"state": state, "made": n, "left": left, "minutes": round((time.time() - t0) / 60, 1)}
                print(f"--- {st}: готово {n}, осталось {left}, {status[st]['minutes']} мин")
            except Exception as e:  # одна упавшая стадия не должна останавливать всю ночь
                traceback.print_exc()
                status[st] = {"state": "error", "error": f"{type(e).__name__}: {e}",
                              "minutes": round((time.time() - t0) / 60, 1)}
                print(f"--- {st}: ОШИБКА, иду дальше")
            status_path.write_text(json.dumps(status, ensure_ascii=False, indent=1), encoding="utf-8")
    finally:
        if project.settings.get("backend", "imagegen") == "imagegen":
            from . import imagegen_backend

            imagegen_backend.server_stop(project.settings, when="idle")
        print(f"\n===== конец, {(time.time() - started) / 3600:.1f} ч. Отчёт: {NIGHT / 'report.html'}")
        try:
            make_report(project, f, status)
        except Exception:
            traceback.print_exc()
        sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__
        log.close()


# --- отчёт -----------------------------------------------------------------------------

def _thumb(src: Path, out: Path, h: int = 220, bg=(236, 236, 236)) -> str:
    out.parent.mkdir(parents=True, exist_ok=True)
    img = Image.open(src)
    if img.mode == "RGBA":
        flat = Image.new("RGB", img.size, bg)
        flat.paste(img, mask=img.getchannel("A"))
        img = flat
    img = img.convert("RGB")
    img.thumbnail((int(h * img.width / max(1, img.height)), h))
    img.save(out, quality=82)
    return str(out.relative_to(NIGHT)).replace("\\", "/")


def _compose_layer(base: Path, layer: Path, erase: Path | None = None) -> Image.Image:
    b = Image.open(base).convert("RGBA")
    if erase and erase.exists():
        import numpy as np

        a = np.asarray(b.getchannel("A")).astype("float32") * (1 - np.asarray(Image.open(erase).convert("L")) / 255.0)
        b.putalpha(Image.fromarray(a.astype("uint8")))
    lay = Image.open(layer).convert("RGBA")
    b.alpha_composite(lay)
    return b


def make_report(project: Project, f: dict, status: dict | None = None):
    """build/night/report.html: всё сгенерированное миниатюрами, чтобы утром быстро просмотреть."""
    status = status or (json.loads((NIGHT / "status.json").read_text(encoding="utf-8"))
                        if (NIGHT / "status.json").exists() else {})
    th = NIGHT / "thumbs"
    parts = ["<!doctype html><meta charset='utf-8'><title>Ночная генерация</title>",
             "<style>body{font:14px system-ui,sans-serif;margin:16px;background:#fafafa;color:#222}"
             "h2{margin-top:28px}figure{display:inline-block;margin:4px;text-align:center;vertical-align:top}"
             "figure img{display:block;border:1px solid #ccc;background:#eee}figcaption{font-size:11px;max-width:200px}"
             ".best img{outline:4px solid #2e7d32}.bad img{outline:4px solid #c62828}"
             "table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:3px 8px}</style>",
             f"<h1>Ночная генерация: {html.escape(str(f.get('title', '')))}</h1>"]
    if status:
        parts.append("<table><tr><th>Стадия</th><th>Состояние</th><th>Сделано</th><th>Осталось</th><th>Мин</th></tr>")
        for st, v in status.items():
            parts.append(f"<tr><td>{TITLES.get(st, st)}</td><td>{v.get('state')} {html.escape(v.get('error', ''))}</td>"
                         f"<td>{v.get('made', '')}</td><td>{v.get('left', '')}</td><td>{v.get('minutes', '')}</td></tr>")
        parts.append("</table>")

    def fig(src: Path, cap: str, cls: str = "", h: int = 220):
        if not src.exists():
            return
        flat = str(src.relative_to(ROOT)).replace("/", "_").replace("\\", "_")
        rel = _thumb(src, th / (flat[:-4] + ".jpg"), h)
        if rel:
            parts.append(f"<figure class='{cls}'><img src='{rel}' height='{h}'><figcaption>{html.escape(cap)}</figcaption></figure>")

    genders, poses = _hero(project, f)
    parts.append("<h2>Базы поз</h2><p>Зелёная рамка: выбранный вариант. Поменять: "
                 "<code>comix doll pick --gender male --pose run --candidate 1</code>, потом снова <code>comix night</code>.</p>")
    for g in genders:
        for p in poses:
            d = doll._paths(g, p)
            info_p = d / "candidates" / "pick.json"
            info = json.loads(info_p.read_text()) if info_p.exists() else {}
            parts.append(f"<div><b>{g} / {p}</b><br>")
            if p == "idle":
                fig(d / "raw_base_light.png", "idle", "best")
            for c in sorted((d / "candidates").glob("raw_base_light_c*.png")):
                k = c.stem.rsplit("_c", 1)[1]
                sc = (info.get("scores") or {}).get(k, {})
                fig(c, f"c{k}: {sc.get('score', '?')} (поза {sc.get('coverage', '?')}, не сдвинулось {sc.get('stale', '?')}, "
                    f"лишнее {sc.get('extra', '?')})",
                    "best" if str(info.get("picked")) == k else "")
            parts.append("</div>")

    parts.append("<h2>Слои героя и NPC (наложены на базу)</h2><p>Красная рамка: автопроверка нашла правку вне слота.</p>")
    for g in genders:
        for p in poses:
            d = doll._paths(g, p)
            base = d / "base_light.png"
            if not base.exists():
                continue
            qa = json.loads((d / "qa.json").read_text()) if (d / "qa.json").exists() else {}
            parts.append(f"<div><b>{g} / {p}</b><br>")
            for lay in sorted(d.glob("*__*.png")):
                if lay.name.startswith("raw_") or lay.stem.endswith(("_skin", "_erase", "_try0", "_try1", "_rgba")):
                    continue
                comp = th / "layers" / f"{g}_{p}_{lay.stem}.png"
                comp.parent.mkdir(parents=True, exist_ok=True)
                _compose_layer(base, lay, d / f"{lay.stem}_erase.png").save(comp)
                q = qa.get(lay.stem, {})
                fig(comp, f"{lay.stem.split('__', 1)[1]} {q.get('spill', '')}", "" if q.get("ok", True) else "bad", 200)
            parts.append("</div>")

    for group in ("enemies", "bosses"):
        parts.append(f"<h2>{TITLES[group]}</h2>")
        for cid in f.get(group) or {}:
            parts.append(f"<div><b>{html.escape((f[group][cid] or {}).get('title', cid))}</b><br>")
            for pose in f.get("creature_poses") or {}:
                fig(sprites.ENEMIES / cid / f"{pose}.png", pose)
            parts.append("</div>")
    for group in ("weapons", "props", "stickers"):
        parts.append(f"<h2>{TITLES[group]}</h2>")
        for sid, v in (f.get(group) or {}).items():
            fig(sprites.SPRITES / group / f"{sid}.png", v.get("title", sid), h=140)
    parts.append(f"<h2>{TITLES['backgrounds']}</h2>")
    for loc, var in _bg_list(project, f):
        fig(background_path(loc, var), f"{loc}/{var}", h=150)
    parts.append(f"<h2>{TITLES['closeups']}</h2>")
    for cid in f.get("closeups") or {}:
        fig(sprites.CLOSEUPS / f"{cid}.png", cid, h=150)
    NIGHT.mkdir(parents=True, exist_ok=True)
    (NIGHT / "report.html").write_text("\n".join(parts), encoding="utf-8")
    print(f"Отчёт: {NIGHT / 'report.html'}")
