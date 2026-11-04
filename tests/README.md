# Проверка ночной фабрики без видеокарты

`tests/fake_imagegen` — фейковый ImageGen с тем же интерфейсом (`jobs.generate/status/server/models`,
`presets.PRESETS`, `presets.klein_graph`). Он проверяет, что графы пресетов собраны без битых ссылок,
и рисует простые фигуры по словам промпта: поза, вещь в слоте, эмоция, лицо NPC.

Прогон на маленьком наборе (картинки попадут в assets/ и web/doll, поэтому лучше в копии репозитория):

```bash
COMIX_IMAGEGEN_PATH=tests/fake_imagegen python -m comix night --world tests/factory_small.yaml
```
