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
from .generate import DRY_DIR, generate_background, generate_character
from .poses import POSES, render_openpose


def _client(project: Project, dry: bool) -> ComfyClient | None:
    if dry:
        return None
    c = project.settings["comfyui"]
    client = ComfyClient(c["url"], c.get("timeout", 600))
    try:
        client.ping()
    except OSError as e:
        sys.exit(f"ComfyUI недоступен по {c['url']} ({e}). Запусти ComfyUI или используй --dry-run.")
    return client


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
        print(f"Сухой прогон: собранные воркфлоу лежат в {DRY_DIR.relative_to(ROOT)}. "
              "Их можно перетащить в ComfyUI и проверить вручную.")


# --- команды ----------------------------------------------------------------

def cmd_ping(args, project):
    c = project.settings["comfyui"]
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


def cmd_gen_characters(args, project):
    client = _client(project, args.dry_run)
    chars = args.char or list(project.characters)
    poses = args.pose or list(POSES)
    override = _parse_outfit(args.outfit)
    done = []
    for cid in chars:
        for pose in poses:
            shot = make_shot(project, cid, pose, override)
            print(f"{cid} / {shot.outfit_key} / {pose}")
            done.append(generate_character(project, shot, client, args.force))
    _report(done, args.dry_run)


def cmd_gen_backgrounds(args, project):
    client = _client(project, args.dry_run)
    locs = args.location or list(project.backgrounds)
    vars_ = args.variation or list(project.variations)
    done = []
    for loc in locs:
        for var in vars_:
            print(f"{loc}/{var}")
            done.append(generate_background(project, loc, var, client, args.force))
    _report(done, args.dry_run)


def cmd_gen_page(args, project):
    """Сгенерировать только то, чего не хватает для сценария."""
    script = load_yaml(Path(args.script))
    shots, bgs = plan(project, script)
    client = _client(project, args.dry_run)
    done = []
    for s in shots:
        if args.force or not s.path.exists():
            print(f"персонаж {s.char_id} / {s.outfit_key} / {s.pose}")
            done.append(generate_character(project, s, client, args.force))
    for loc, var in bgs:
        print(f"фон {loc}/{var}")
        done.append(generate_background(project, loc, var, client, args.force))
    _report(done, args.dry_run)


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

    sub.add_parser("ping", help="проверить связь с ComfyUI").set_defaults(fn=cmd_ping)
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

    gen = sub.add_parser("gen", help="генерация через ComfyUI").add_subparsers(dest="sub", required=True)
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

    p = sub.add_parser("page", help=f"собрать страницу из сценария (раскладки: {', '.join(LAYOUTS)})")
    p.add_argument("script")
    p.add_argument("-o", "--out")
    p.set_defaults(fn=cmd_page)

    args = ap.parse_args(argv)
    args.fn(args, Project.load())


if __name__ == "__main__":
    main()
