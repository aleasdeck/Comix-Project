# Comix Project: генератор страниц комикса

Пайплайн собирает страницу комикса на 3–5 кадров:

1. **Персонажи**: пол, цвет кожи, внешность и одежда по слотам (голова, верх, низ, обувь). Генерируются через **Flux** или **Z-Image** в ComfyUI.
2. **5 универсальных поз**: `idle` (стоит), `talk` (говорит), `point` (указывает), `walk` (идёт), `shock` (удивлён). Для каждой есть скелет OpenPose, через ControlNet он даёт одну и ту же позу при любой одежде.
3. **Фоны** через **Qwen-Image**: 5 локаций × 5 вариаций (ракурс, время суток), чтобы кадры отличались.
4. **Облачки**: реплика, мысли, крик, шёпот, подпись. Рисуются кодом, а не нейросетью: контур ровный, размер подстраивается под текст, хвостик смотрит на говорящего.
5. **Компоновщик**: собирает страницу по сценарию в YAML.

Пока картинок нет, вместо них подставляются черновики (фигурки в цветах одежды). Так можно отладить сценарий и раскладку ещё до генерации.

![пример](docs/example_page.png)

## Установка

```bash
pip install -r requirements.txt
# по желанию, для качественного удаления фона у персонажей:
pip install rembg[gpu]
```

Нужен запущенный **ComfyUI** (по умолчанию `http://127.0.0.1:8188`, адрес задаётся в `config/settings.yaml`).

### Модели в ComfyUI

Имена файлов указываются в `config/settings.yaml` → `models`. По умолчанию ожидается:

| Что | Папка ComfyUI | Файл |
|---|---|---|
| Flux dev | `models/diffusion_models` | `flux1-dev.safetensors` |
| T5 + CLIP-L | `models/text_encoders` | `t5xxl_fp8_e4m3fn.safetensors`, `clip_l.safetensors` |
| Flux VAE | `models/vae` | `ae.safetensors` |
| ControlNet для поз | `models/controlnet` | `flux-controlnet-union-pro-2.0.safetensors` |
| Z-Image Turbo | `models/diffusion_models` | `z_image_turbo_bf16.safetensors` + `qwen_3_4b.safetensors` |
| Qwen-Image | `models/diffusion_models` | `qwen_image_fp8_e4m3fn.safetensors` + `qwen_2.5_vl_7b_fp8_scaled.safetensors` + `qwen_image_vae.safetensors` |

Если ControlNet нет, поставь `use_pose_controlnet: false`: тогда поза задаётся только текстом промпта.

## Команды

```bash
python -m comix ping                         # есть ли связь с ComfyUI
python -m comix wardrobe                     # каталог одежды
python -m comix character list
python -m comix character new                # создать персонажа, спросит всё по шагам
python -m comix character new --id kate --gender female --skin dark \
    --hair "short white hair" --outfit head=fedora top=trench_coat bottom=black_trousers shoes=boots

python -m comix poses                        # скелеты OpenPose и превью поз -> assets/poses
python -m comix bubbles                      # набор PNG облачков -> assets/bubbles

python -m comix gen characters --char alex                  # alex во всех 5 позах
python -m comix gen characters --char alex --outfit head=fedora top=trench_coat
python -m comix gen backgrounds --location street           # все вариации улицы
python -m comix gen page scripts/example_page.yaml          # только то, чего не хватает странице

python -m comix page scripts/example_page.yaml              # собрать страницу -> output/
```

У любой `gen` есть `--dry-run`: ничего не генерируется, собранные воркфлоу сохраняются в `build/dry_run/*.json`. Их можно открыть в ComfyUI и проверить. `--force` перегенерирует уже готовое.

## Как устроено

```
config/
  settings.yaml      адрес ComfyUI, модели, размеры, стиль, шрифт
  characters.yaml    персонажи и оттенки кожи
  wardrobe.yaml      одежда по слотам head / top / bottom / shoes
  backgrounds.yaml   локации и вариации фонов
workflows/           шаблоны ComfyUI (формат API) с плейсхолдерами {{...}}
scripts/             сценарии страниц
comix/               код
assets/
  characters/<id>/<голова-верх-низ-обувь>/<поза>.png   вырезанный персонаж (PNG с прозрачностью)
  backgrounds/<локация>/<вариация>.png
  poses/, bubbles/
```

**Смена одежды.** Каждая картинка персонажа хранится по ключу наряда. В сценарии у любого персонажа в любом кадре можно заменить отдельные слоты (`outfit: {head: hero_mask}`), и `gen page` догенерирует именно эту комбинацию.

**Похожесть лица.** У персонажа фиксированный `seed`, он один для всех поз и нарядов. Для полной стабильности лица следующим шагом можно добавить LoRA персонажа или PuLID / IP-Adapter в воркфлоу.

**Свой воркфлоу.** Собери граф в ComfyUI, включи Dev mode, сделай *Export (API)* и замени нужные значения плейсхолдерами: `{{POSITIVE}}`, `{{NEGATIVE}}`, `{{SEED}}`, `{{WIDTH}}`, `{{HEIGHT}}`, `{{STEPS}}`, `{{CFG}}`, `{{GUIDANCE}}`, `{{UNET}}`, `{{CLIP}}`, `{{CLIP_T5}}`, `{{CLIP_L}}`, `{{VAE}}`, `{{CONTROLNET}}`, `{{POSE_IMAGE}}`, `{{PREFIX}}`. Потом пропиши путь к нему в `settings.yaml` → `workflows`.

## Сценарий страницы

См. `scripts/example_page.yaml`. Раскладки: `3a 3b 3c 4a 4b 4c 5a 5b` или `auto`.

```yaml
layout: 4b
panels:
  - background: street/day_wide
    characters:
      - {id: alex, pose: walk, x: 0.5, y: 0.97, height: 0.8}
    bubbles:
      - {kind: speech, text: "Привет!", x: 0.3, y: 0.15, tail_to: alex}
```

Координаты задаются в долях кадра (0..1): `x` — центр персонажа, `y` — линия ступней, `height` — рост относительно высоты кадра (больше 1 даёт крупный план). Для облачка `x`, `y` — его центр, `tail_to` — id персонажа или точка `[x, y]`.

Для кириллицы в облачках нужен шрифт с кириллицей. Список кандидатов задаётся в `settings.yaml` → `fonts.bubble`, первым проверяется `assets/fonts/bubble.ttf`.
