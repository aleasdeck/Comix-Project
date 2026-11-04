// Мелочи интерфейса: создание элементов, окно поверх страницы, выбор из карточек.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Record<string, unknown> = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "html") el.innerHTML = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export interface Overlay { root: HTMLElement; box: HTMLElement; close: () => void }

/** Окно поверх страницы комикса. */
export function overlay(cls = ""): Overlay {
  const box = h("div", { class: `ov-box ${cls}`, role: "dialog", "aria-modal": "true" });
  const root = h("div", { class: "ov" }, box);
  document.body.append(root);
  document.body.classList.add("has-ov");
  return {
    root, box,
    close: () => {
      root.remove();
      if (!document.querySelector(".ov")) document.body.classList.remove("has-ov");
    },
  };
}

export interface Card {
  title: string;
  body?: string | Node;
  icon?: Node;
  tag?: string;
  disabled?: string;   // причина, почему нельзя
}

/** Выбор одной карточки. skip: подпись кнопки «пропустить» (тогда может вернуться -1). */
export function pickCard(title: string, sub: string, cards: Card[], skip?: string, cls = ""): Promise<number> {
  return new Promise((ok) => {
    const ov = overlay(`pick ${cls}`);
    const done = (i: number) => { ov.close(); ok(i); };
    const list = h("div", { class: "cards" });
    cards.forEach((c, i) => {
      list.append(h("button", { class: "card", disabled: !!c.disabled, onclick: () => done(i) },
        c.icon ? h("div", { class: "card-icon" }, c.icon) : null,
        c.tag ? h("span", { class: "card-tag" }, c.tag) : null,
        h("b", {}, c.title),
        typeof c.body === "string" ? h("span", {}, c.body) : c.body || null,
        c.disabled ? h("em", {}, c.disabled) : null));
    });
    ov.box.append(h("h2", {}, title));
    if (sub) ov.box.append(h("p", { class: "tip" }, sub));
    ov.box.append(list);
    if (skip) ov.box.append(h("button", { class: "ghost", onclick: () => done(-1) }, skip));
    (list.querySelector("button:not([disabled])") as HTMLButtonElement | null)?.focus();
  });
}

/** Короткая плашка поверх всего: «Шанс 60%… Успех!». */
export async function stamp(text: string, good: boolean, ms = 1100) {
  const el = h("div", { class: `stamp ${good ? "good" : "bad"}`, role: "status" }, text);
  document.body.append(el);
  await wait(ms);
  el.classList.add("out");
  await wait(250);
  el.remove();
}
