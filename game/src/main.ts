// Комикс-рогалик: страница комикса собирается из твоих выборов. Здесь только запуск и кнопки,
// сам забег в game.ts.

import "./style.css";
import { loadManifest, missingSummary, watchMissing } from "./assets";
import { Game } from "./game";
import { wait } from "./ui";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function showMissing() {
  const t = missingSummary();
  const el = $("missing");
  el.hidden = !t;
  el.textContent = t ? `Пока без картинок, вместо них заглушки. ${t}` : "";
}

async function fonts() {
  const list = ["25px Neucha", '56px "Russo One"', "500 21px Rubik"];
  await Promise.race([Promise.all(list.map((f) => document.fonts.load(f))), wait(2500)]).catch(() => {});
}

async function main() {
  watchMissing(() => requestAnimationFrame(showMissing));
  const [gm] = await Promise.all([loadManifest(), fonts()]);
  const game = new Game(gm, { pages: $("pages"), hero: $("hero"), choose: $("choose"), title: $("chooseTitle"), box: $("choices") });
  (window as unknown as { game: Game }).game = game;
  $("restart").addEventListener("click", () => {
    if (game.run && !game.over && !confirm("Начать новый выпуск? Этот забег пропадёт.")) return;
    void game.start();
  });
  $("savePage").addEventListener("click", () => game.savePage());
  $("saveComic").addEventListener("click", () => void game.saveComic());
  void game.start();
}

void main();
