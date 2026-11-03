"""Командная строка: python -m comix <команда>. Список: python -m comix -h"""

from __future__ import annotations

import argparse
import sys
import zlib
from pathlib import Path

from . import bubbles, placeholder
from .comfy import ComfyClient
from .compose import LAYOUTS, compose_file, plan
from .config import ASSETS, CONFIG, ROOT, SLOTS, Project, load_yaml, make_shot, save_yaml
from .generate import DRY_DIR, generate_backgrounds, generate_characters
from .poses import POSES, render_openpose


def _parse_outfit(pairs: list[str] | None) -> dict:
    out = {}
    for p in pairs or []:
        slot, _, item = p.partition("=")
        if slot not in SLOTS:
            sys.exit(f"Неизвестный слот '{slot}', есть: {', '.join(SLOTS)}")
        out[slot] = item
    return out


def _report(paths, dry: bool):
    for p in paths:
        print(("  воркфлоу: " if dry else "  готово: ") + str(Path(p).relative_to(ROOT)))
    if dry:
        print(f"Сухой прогон: ничего не генерировалось, задания лежат в {DRY_DIR.relative_to(ROOT)}.")
    elif not paths:
        print("Всё уже сгенерировано (перегенерировать: --force).")


# --- команды ----------------------------------------------------------------

def cmd_ping(args, project):
    s = project.settings
    if s.get("backend", "imagegen") == "imagegen":
        from . import imagegen_backend
        need = {s["imagegen"]["character_model"], s["imagegen"]["background_model"]}
        for m in imagegen_backend.models(s):
            if m["name"] in need:
                state = "установлена" if m["installed"] else f"НЕ ХВАТАЕТ {m.get('missing')}"
                print(f"{m['name']:10} {m['model']}: {state}")
        return
    c = s["comfyui"]
    stats = ComfyClient(c["url"]).ping()
    dev = (stats.get("devices") or [{}])[0]
    print(f"ComfyUI на связи: {c['url']}, GPU: {dev.get('name', '?')}")


def cmd_poses(args, project):
    out = ASSETS / "poses"
    out.mkdir(parents=True, exist_ok=True)
    size = tuple(project.settings["sizes"]["character"])
    for pid, p in POSES.items():
        render_openpose(pid, size).save(out / f"{pid}_openpose.png")
        print(f"  {pid:6} {p['title']}")
    char = args.char or next(iter(project.characters))
    for pid in POSES:
        placeholder.character(project, make_shot(project, char, pid)).save(out / f"{pid}_preview.png")
    print(f"Скелеты и превью поз сохранены в {out.relative_to(ROOT)}")


def cmd_bubbles(args, project):
    fonts = project.settings["fonts"]
    font = bubbles.load_font(tuple(fonts["bubble"]), fonts.get("bubble_size", 34))
    paths = bubbles.export_pack(font, ASSETS / "bubbles")
    print(f"Облачков: {len(paths)}, папка {(ASSETS / 'bubbles').relative_to(ROOT)}")


def cmd_wardrobe(args, project):
    for slot in SLOTS:
        print(f"[{slot}]")
        for item, v in (project.wardrobe.get(slot) or {}).items():
            print(f"  {item:16} {v.get('prompt', '')}")


def cmd_char_list(args, project):
    for cid, c in project.characters.items():
        o = c.get("outfit", {})
        print(f"{cid:10} {c.get('name', ''):10} {c.get('gender'):6} кожа={c.get('skin'):7} "
              + " ".join(f"{s}={o.get(s, 'none')}" for s in SLOTS))


def _ask(prompt: str, options: list[str], default: str | None = None) -> str:
    print(prompt)
    for i, o in enumerate(options, 1):
        print(f"  {i}. {o}")
    while True:
        raw = input(f"> [{default or options[0]}] ").strip()
        if not raw:
            return default or options[0]
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return options[int(raw) - 1]
        if raw in options:
            return raw
        print("Выбери номер из списка.")


def cmd_char_new(args, project):
    """Создать персонажа: интерактивно или флагами."""
    interactive = not (args.id and args.gender and args.skin)
    cid = args.id or input("id персонажа (латиницей): ").strip()
    if not cid:
        sys.exit("Нужен id")
    gender = args.gender or _ask("Пол:", ["male", "female"])
    skin = args.skin or _ask("Цвет кожи:", list(project.skin_tones))
    outfit = _parse_outfit(args.outfit)
    for slot in SLOTS:
        if slot not in outfit:
            items = list(project.wardrobe.get(slot) or {})
            outfit[slot] = _ask(f"{slot}:", items) if interactive else items[0]
    name = args.name or (input("Имя (для себя): ").strip() if interactive else cid) or cid
    hair = args.hair or (input("Волосы (англ., напр. 'short black hair'): ").strip() if interactive else "")
    features = args.features or (input("Особенности лица (англ., можно пусто): ").strip() if interactive else "")

    data = load_yaml(CONFIG / "characters.yaml")
    data.setdefault("characters", {})[cid] = {
        "name": name, "gender": gender, "skin": skin, "age": args.age,
        "hair": hair, "features": features,
        "seed": args.seed if args.seed is not None else zlib.crc32(cid.encode()) % 10 ** 6,
        "outfit": outfit,
    }
    save_yaml(CONFIG / "characters.yaml", data)
    project = Project.load()
    out = ASSETS / "previews"
    out.mkdir(parents=True, exist_ok=True)
    placeholder.character(project, make_shot(project, cid, "idle")).save(out / f"{cid}.png")
    print(f"Персонаж '{cid}' записан в config/characters.yaml, черновое превью: assets/previews/{cid}.png")
    print(f"Сгенерировать все позы: python -m comix gen characters --char {cid}")


def _maybe_stop(project, dry):
    s = project.settings
    if not dry and s.get("backend", "imagegen") == "imagegen" and s["imagegen"].get("stop_after", True):
        from . import imagegen_backend
        imagegen_backend.server_stop(s, when="idle")


def cmd_gen_characters(args, project):
    chars = args.char or list(project.characters)
    poses = args.pose or list(POSES)
    override = _parse_outfit(args.outfit)
    shots = [make_shot(project, cid, pose, override) for cid in chars for pose in poses]
    for sh in shots:
        print(f"{sh.char_id} / {sh.outfit_key} / {sh.pose}")
    done = generate_characters(project, shots, args.dry_run, args.force)
    _maybe_stop(project, args.dry_run or not done)
    _report(done, args.dry_run)


def cmd_gen_backgrounds(args, project):
    locs = args.location or list(project.backgrounds)
    vars_ = args.variation or list(project.variations)
    bgs = [(l, v) for l in locs for v in vars_]
    print(f"фонов: {len(bgs)}")
    done = generate_backgrounds(project, bgs, args.dry_run, args.force)
    _maybe_stop(project, args.dry_run or not done)
    _report(done, args.dry_run)


def cmd_gen_page(args, project):
    """Сгенерировать только то, чего не хватает для сценария."""
    script = load_yaml(Path(args.script))
    shots, bgs = plan(project, script)
    # сначала персонажи, потом фоны: Qwen тяжёлый, ImageGen перезапускает ComfyUI при переходе
    done = generate_characters(project, shots, args.dry_run, args.force)
    done += generate_backgrounds(project, bgs, args.dry_run, args.force)
    _maybe_stop(project, args.dry_run or not done)
    _report(done, args.dry_run)


def cmd_recut(args, project):
    """Заново вырезать персонажей из сохранённых *_raw.png (без генерации)."""
    from PIL import Image

    from .cutout import cutout, trim

    cfg = project.settings.get("cutout", {})
    raws = sorted((ASSETS / "characters").rglob("*_raw.png"))
    for raw in raws:
        out = raw.with_name(raw.name.replace("_raw.png", ".png"))
        trim(cutout(Image.open(raw), cfg.get("method", "auto"), cfg.get("tolerance", 28))).save(out)
        print(f"  {out.relative_to(ROOT)}")
    print(f"Перевырезано: {len(raws)}")


def cmd_doll_build(args, project):
    from . import doll
    skins = args.skin or ["light"] + [k for k in project.skin_tones if k != "light"]
    items = doll.items_from_sets(project, args.set)
    poses = args.pose or ["idle"]
    n = len(args.gender) * (1 + (len(poses) - 1) + len(poses) * (len(skins) - 1 + sum(map(len, items.values()))))
    print(f"Кукла: пол {args.gender}, позы {poses}, кожа {len(skins)}, вещей {sum(map(len, items.values()))}; "
          f"картинок до ~{n}")
    doll.build(project, args.gender, poses, skins, items, force=args.force)
    _maybe_stop(project, False)


def cmd_doll_reprocess(args, project):
    from . import doll
    doll.reprocess(project)


def cmd_doll_export(args, project):
    from . import doll
    doll.export(Path(args.out), args.scale)


def cmd_page(args, project):
    out = Path(args.out) if args.out else ROOT / "output" / (Path(args.script).stem + ".png")
    missing = compose_file(project, Path(args.script), out)
    print(f"Страница: {out}")
    if missing:
        uniq = sorted({(m.kind, m.what) for m in missing})
        print(f"Нет картинок ({len(uniq)}), вместо них черновики:")
        for kind, what in uniq:
            print(f"  {kind}: {Path(what).relative_to(ROOT)}")
        print(f"Сгенерировать недостающее: python -m comix gen page {args.script}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="comix", description="Генератор страниц комикса")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ping", help="проверить генератор и модели").set_defaults(fn=cmd_ping)
    p = sub.add_parser("poses", help="скелеты OpenPose и превью 5 поз")
    p.add_argument("--char")
    p.set_defaults(fn=cmd_poses)
    sub.add_parser("bubbles", help="набор PNG облачков").set_defaults(fn=cmd_bubbles)
    sub.add_parser("wardrobe", help="список одежды по слотам").set_defaults(fn=cmd_wardrobe)

    ch = sub.add_parser("character", help="персонажи").add_subparsers(dest="sub", required=True)
    ch.add_parser("list").set_defaults(fn=cmd_char_list)
    p = ch.add_parser("new", help="создать персонажа (без флагов спросит всё по шагам)")
    p.add_argument("--id")
    p.add_argument("--name")
    p.add_argument("--gender", choices=["male", "female"])
    p.add_argument("--skin")
    p.add_argument("--age", default="young adult")
    p.add_argument("--hair")
    p.add_argument("--features")
    p.add_argument("--seed", type=int)
    p.add_argument("--outfit", nargs="*", metavar="СЛОТ=ПРЕДМЕТ")
    p.set_defaults(fn=cmd_char_new)

    gen = sub.add_parser("gen", help="генерация (ImageGen или ComfyUI)").add_subparsers(dest="sub", required=True)
    p = gen.add_parser("characters", help="персонажи во всех (или выбранных) позах")
    p.add_argument("--char", nargs="*")
    p.add_argument("--pose", nargs="*", choices=list(POSES))
    p.add_argument("--outfit", nargs="*", metavar="СЛОТ=ПРЕДМЕТ", help="заменить слоты, напр. head=fedora")
    p.set_defaults(fn=cmd_gen_characters)
    p = gen.add_parser("backgrounds", help="фоны: локации x вариации")
    p.add_argument("--location", nargs="*")
    p.add_argument("--variation", nargs="*")
    p.set_defaults(fn=cmd_gen_backgrounds)
    p = gen.add_parser("page", help="всё недостающее для сценария")
    p.add_argument("script")
    p.set_defaults(fn=cmd_gen_page)
    for g in gen.choices.values():
        g.add_argument("--dry-run", action="store_true", help="не генерировать, только собрать воркфлоу")
        g.add_argument("--force", action="store_true", help="перегенерировать существующие")

    dl = sub.add_parser("doll", help="бумажная кукла: слои тела и одежды").add_subparsers(dest="sub", required=True)
    p = dl.add_parser("build", help="сгенерировать базу, цвета кожи и вещи из сетов")
    p.add_argument("--gender", nargs="*", default=["male", "female"], choices=["male", "female"])
    p.add_argument("--pose", nargs="*", choices=list(POSES))
    p.add_argument("--skin", nargs="*", help="первый — базовый (на нём рисуется одежда)")
    p.add_argument("--set", nargs="*", help="названия сетов из wardrobe.yaml (по умолчанию все)")
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_doll_build)
    dl.add_parser("reprocess", help="пересобрать слои из сырых картинок без генерации").set_defaults(fn=cmd_doll_reprocess)
    p = dl.add_parser("export", help="уменьшенные слои + manifest для страницы")
    p.add_argument("out")
    p.add_argument("--scale", type=float, default=0.5)
    p.set_defaults(fn=cmd_doll_export)

    sub.add_parser("recut", help="заново вырезать персонажей из *_raw.png").set_defaults(fn=cmd_recut)

    p = sub.add_parser("page", help=f"собрать страницу из сценария (раскладки: {', '.join(LAYOUTS)})")
    p.add_argument("script")
    p.add_argument("-o", "--out")
    p.set_defaults(fn=cmd_page)

    args = ap.parse_args(argv)
    args.fn(args, Project.load())


if __name__ == "__main__":
    main()
