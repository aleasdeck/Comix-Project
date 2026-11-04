# Игра в браузере

Код игры лежит в `game/` (Vite + TypeScript, без фреймворков). Сейчас это демо движка: страница комикса
заполняется кадр за кадром, а на развилке следующий пустой кадр показывает карандашный эскиз варианта.
Выбранный вариант прорисовывается тушью и цветом. Сюжет пролога временный, настоящие сцены появятся после
утверждения концепта.

Чего уже нет в картинках, игра рисует заглушкой и пишет внизу страницы, чего не хватает.

## Картинки после ночной генерации

Ночной прогон сам выгружает картинки в игру (стадия `game_export`). Вручную это делается так:

```bat
comix.bat export-game
git add game/public/assets
git commit -m "Картинки для игры"
git push
```

`export-game` кладёт в `game/public/assets` уменьшенные webp и `manifest.json`: куклу героя во всех позах,
фоны, врагов, вещи, наклейки и крупные планы. Всё вместе для города весит примерно 20–40 МБ.

## Запуск на своём ПК

Нужен Node.js 22 (один раз: `winget install OpenJS.NodeJS.LTS`). Потом:

```bat
game.bat
```

Откроется браузер с игрой, правки в `game/src` подхватываются сразу.

## GitHub Pages

После каждого push в ветку `claude/project-thread-r11h4h`, если менялась папка `game/`, GitHub Actions собирает игру
(`.github/workflows/pages.yml`). Пока репозиторий закрытый, выполняется только сборка, без публикации.

Когда откроешь репозиторий:

1. **Settings → Pages → Build and deployment → Source:** выбрать **GitHub Actions**.
2. **Settings → Environments → github-pages → Deployment branches:** добавить ветку
   `claude/project-thread-r11h4h`, если там разрешена только ветка по умолчанию.
3. **Actions → «Игра на GitHub Pages» → Run workflow** (или любой push в `game/`).

Игра будет по адресу `https://aleasdeck.github.io/Comix-Project/`.

Если репозиторий останется закрытым, Pages работает только на платном плане GitHub. Тогда после шага 1
добавь переменную репозитория `PAGES_ENABLED` со значением `true` (Settings → Secrets and variables → Actions → Variables).
