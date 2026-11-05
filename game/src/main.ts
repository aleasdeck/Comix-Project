// Комикс-рогалик: страница комикса собирается из твоих выборов. Здесь только запуск и кнопки,
// сам забег в game.ts, листание страниц в book.ts.

import "./style.css";
import { loadManifest, missingSummary, watchMissing } from "./assets";
import { Book } from "./book";
import { Game } from "./game";
import { PAGE_H, PAGE_W } from "./page";
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
  const book = new Book($("pages"), document.querySelector(".book-frame") as HTMLElement,
    { prev: $("prevPage"), next: $("nextPage"), no: $("pageNo") }, PAGE_W / PAGE_H);
  const heroDlg = $<HTMLDialogElement>("heroDlg");
  const chip = $<HTMLButtonElement>("heroBtn");
  const game = new Game(gm, {
    pages: $("pages"), hero: $("hero"), choose: $("choose"), title: $("chooseTitle"), box: $("choices"),
    book, chip, heroDlg,
  });
  (window as unknown as { game: Game; book: Book }).game = game;
  (window as unknown as { book: Book }).book = book;

  // карточка героя: окно по кнопке, закрывается крестиком, Esc или щелчком мимо окна
  chip.addEventListener("click", () => heroDlg.showModal());
  $("heroClose").addEventListener("click", () => heroDlg.close());
  heroDlg.addEventListener("click", (e) => {
    const r = heroDlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) heroDlg.close();
  });

  // на телефоне выбор выезжает шторкой; её можно свернуть, чтобы посмотреть страницу целиком
  const choose = $("choose"), sheet = $("sheetBtn");
  const setSheet = (min: boolean) => { choose.classList.toggle("min", min); sheet.setAttribute("aria-expanded", String(!min)); };
  sheet.addEventListener("click", () => setSheet(!choose.classList.contains("min")));
  $("chooseTitle").addEventListener("click", () => { if (choose.classList.contains("min")) setSheet(false); });
  new MutationObserver(() => setSheet(false)).observe($("choices"), { childList: true });

  // на телефоне кнопки шапки прячутся в меню
  const menu = $("menuBtn"), tools = $("tools");
  const setMenu = (on: boolean) => { tools.classList.toggle("open", on); menu.setAttribute("aria-expanded", String(on)); };
  menu.addEventListener("click", (e) => { e.stopPropagation(); setMenu(!tools.classList.contains("open")); });
  tools.addEventListener("click", () => setMenu(false));
  document.addEventListener("click", (e) => { if (!tools.contains(e.target as Node)) setMenu(false); });
  $("restart").addEventListener("click", () => {
    if (game.run && !game.over && !confirm("Начать новый выпуск? Этот забег пропадёт.")) return;
    void game.start();
  });
  $("savePage").addEventListener("click", () => game.savePage());
  $("saveComic").addEventListener("click", () => void game.saveComic());
  void game.start();
}

void main();
