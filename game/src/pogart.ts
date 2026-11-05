// Печать на фишках: лицевая сторона с приёмом, рубашка, бортик, битка и игровой коврик.
// Всё рисуется кодом в canvas: одни и те же картинки идут в 3D-стол и в стопку сбоку.

export interface PogLike { owner: "hero" | "enemy"; act: string; n: number; times?: number; name: string }

const RIM: Record<string, string> = { hero: "#1d6f8f", enemy: "#b3262d" };
const FILL: Record<string, string> = {
  hit: "#ffd23f", block: "#8cc4ff", dodge: "#9ff0d8", heal: "#9be29b", double: "#ff9de2", stun: "#cfb3ff",
  ink: "#c9d0ff", coin: "#ffe08a", shield: "#b4c2d2", rage: "#ff8a5c", knock: "#ffcf9e", trap: "#ffd25e",
};
const WORD: Record<string, string> = {
  hit: "УДАР", block: "БЛОК", dodge: "УВОРОТ", heal: "ЛЕЧЕНИЕ", double: "×2", stun: "ОГЛУШЕНИЕ", ink: "ЧЕРНИЛО",
  coin: "МОНЕТЫ", shield: "ЩИТ", rage: "ЯРОСТЬ", knock: "ВЫБИТЬ", trap: "ЛОВУШКА",
};

const FONT = '"Russo One", Rubik, sans-serif';

function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function canvas(w: number, h = w) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

/** Текст по дуге: top сверху по часовой, иначе снизу против часовой. */
function arcText(x: CanvasRenderingContext2D, text: string, cx: number, cy: number, r: number, top: boolean, size: number) {
  x.save();
  x.font = `${size}px ${FONT}`;
  x.textAlign = "center"; x.textBaseline = "middle";
  const chars = [...text];
  const widths = chars.map((ch) => x.measureText(ch).width + size * 0.08);
  const total = widths.reduce((a, b) => a + b, 0);
  const span = Math.min(total / r, Math.PI * 0.9);
  const k = span / total;
  let a = (top ? -Math.PI / 2 : Math.PI / 2) + (top ? -span / 2 : span / 2);
  chars.forEach((ch, i) => {
    const w = widths[i] * k;
    a += top ? w / 2 : -w / 2;
    x.save();
    x.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    x.rotate(top ? a + Math.PI / 2 : a - Math.PI / 2);
    x.fillText(ch, 0, 0);
    x.restore();
    a += top ? w / 2 : -w / 2;
  });
  x.restore();
}

function rays(x: CanvasRenderingContext2D, cx: number, cy: number, r: number, a: string, b: string, n = 16) {
  for (let i = 0; i < n; i++) {
    x.beginPath(); x.moveTo(cx, cy);
    x.arc(cx, cy, r, (i / n) * Math.PI * 2, ((i + 1) / n) * Math.PI * 2);
    x.closePath();
    x.fillStyle = i % 2 ? a : b; x.fill();
  }
}

function dots(x: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  x.save();
  x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.clip();
  x.fillStyle = color;
  for (let y = cy - r; y < cy + r; y += 9)
    for (let xx = cx - r + ((y / 9) % 2 ? 4.5 : 0); xx < cx + r; xx += 9) {
      const d = Math.hypot(xx - cx, y - cy) / r;
      x.beginPath(); x.arc(xx, y, 1.2 + d * 1.6, 0, Math.PI * 2); x.fill();
    }
  x.restore();
}

function burst(x: CanvasRenderingContext2D, cx: number, cy: number, r: number, n = 12) {
  x.beginPath();
  for (let i = 0; i <= n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2, k = i % 2 ? 0.7 : 1;
    const px = cx + Math.cos(a) * r * k, py = cy + Math.sin(a) * r * k;
    if (i) x.lineTo(px, py); else x.moveTo(px, py);
  }
  x.closePath();
}

function icon(x: CanvasRenderingContext2D, act: string, cx: number, cy: number, s: number) {
  x.save();
  x.lineJoin = "round"; x.lineCap = "round";
  x.strokeStyle = "#16161c"; x.lineWidth = s * 0.07; x.fillStyle = "#fff";
  switch (act) {
    case "hit": burst(x, cx, cy, s * 0.62); x.fill(); x.stroke(); break;
    case "block": case "shield":
      x.beginPath();
      x.moveTo(cx, cy - s * 0.58); x.lineTo(cx + s * 0.48, cy - s * 0.4); x.lineTo(cx + s * 0.42, cy + s * 0.1);
      x.quadraticCurveTo(cx + s * 0.3, cy + s * 0.45, cx, cy + s * 0.62);
      x.quadraticCurveTo(cx - s * 0.3, cy + s * 0.45, cx - s * 0.42, cy + s * 0.1);
      x.lineTo(cx - s * 0.48, cy - s * 0.4); x.closePath();
      x.fillStyle = act === "shield" ? "#e6ebf2" : "#fff"; x.fill(); x.stroke();
      break;
    case "heal": {
      const w = s * 0.22, l = s * 0.55;
      x.beginPath();
      x.moveTo(cx - w, cy - l); x.lineTo(cx + w, cy - l); x.lineTo(cx + w, cy - w); x.lineTo(cx + l, cy - w);
      x.lineTo(cx + l, cy + w); x.lineTo(cx + w, cy + w); x.lineTo(cx + w, cy + l); x.lineTo(cx - w, cy + l);
      x.lineTo(cx - w, cy + w); x.lineTo(cx - l, cy + w); x.lineTo(cx - l, cy - w); x.lineTo(cx - w, cy - w); x.closePath();
      x.fill(); x.stroke();
      break;
    }
    case "dodge":
      x.lineWidth = s * 0.1;
      for (const k of [-1, 0, 1]) {
        x.beginPath(); x.moveTo(cx - s * 0.55, cy + k * s * 0.28); x.quadraticCurveTo(cx, cy + k * s * 0.28 - s * 0.2, cx + s * 0.5, cy + k * s * 0.28);
        x.stroke();
      }
      break;
    case "stun":
      x.lineWidth = s * 0.09;
      x.beginPath();
      for (let t = 0; t < 14; t += 0.2) {
        const r = s * 0.05 * t, a = t * 1.1;
        const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r * 0.8;
        if (t) x.lineTo(px, py); else x.moveTo(px, py);
      }
      x.stroke();
      break;
    case "ink":
      x.beginPath();
      x.moveTo(cx, cy - s * 0.6);
      x.bezierCurveTo(cx + s * 0.5, cy, cx + s * 0.4, cy + s * 0.55, cx, cy + s * 0.55);
      x.bezierCurveTo(cx - s * 0.4, cy + s * 0.55, cx - s * 0.5, cy, cx, cy - s * 0.6);
      x.fillStyle = "#2b2f6e"; x.fill(); x.stroke();
      break;
    case "coin":
      x.beginPath(); x.arc(cx, cy, s * 0.55, 0, Math.PI * 2); x.fillStyle = "#ffd23f"; x.fill(); x.stroke();
      x.beginPath(); x.arc(cx, cy, s * 0.4, 0, Math.PI * 2); x.stroke();
      break;
    case "rage":
      x.beginPath();
      x.moveTo(cx, cy - s * 0.62);
      x.bezierCurveTo(cx + s * 0.2, cy - s * 0.3, cx + s * 0.55, cy - s * 0.1, cx + s * 0.42, cy + s * 0.3);
      x.bezierCurveTo(cx + s * 0.3, cy + s * 0.6, cx - s * 0.3, cy + s * 0.6, cx - s * 0.42, cy + s * 0.3);
      x.bezierCurveTo(cx - s * 0.55, cy, cx - s * 0.2, cy - s * 0.15, cx, cy - s * 0.62);
      x.fillStyle = "#ffef8a"; x.fill(); x.stroke();
      break;
    case "knock":
      x.beginPath();
      x.rect(cx - s * 0.3, cy - s * 0.5, s * 0.6, s * 0.65);
      x.fillStyle = "#3a3340"; x.fill(); x.stroke();
      x.beginPath(); x.ellipse(cx, cy + s * 0.18, s * 0.6, s * 0.14, 0, 0, Math.PI * 2); x.fill(); x.stroke();
      break;
    case "trap":
      x.beginPath();
      x.moveTo(cx, cy - s * 0.6); x.lineTo(cx + s * 0.62, cy + s * 0.48); x.lineTo(cx - s * 0.62, cy + s * 0.48); x.closePath();
      x.fillStyle = "#fff"; x.fill(); x.stroke();
      break;
  }
  x.restore();
}

function gloss(x: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  x.save();
  x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.clip();
  const g = x.createLinearGradient(cx - r, cy - r, cx + r * 0.3, cy + r * 0.3);
  g.addColorStop(0, "rgba(255,255,255,.42)"); g.addColorStop(0.45, "rgba(255,255,255,.08)"); g.addColorStop(0.46, "rgba(255,255,255,0)");
  x.fillStyle = g; x.fillRect(cx - r, cy - r, r * 2, r * 2);
  x.restore();
}

const faces = new Map<string, HTMLCanvasElement>();

/** Лицевая сторона фишки 256×256. */
export function pogFace(c: PogLike): HTMLCanvasElement {
  const key = `${c.owner}|${c.act}|${c.n}|${c.times || 1}|${c.name}`;
  const hit = faces.get(key);
  if (hit) return hit;
  const S = 256, cv = canvas(S), x = cv.getContext("2d")!;
  const cx = S / 2, cy = S / 2;
  const trap = c.act === "trap";
  // бортик
  x.beginPath(); x.arc(cx, cy, 126, 0, Math.PI * 2);
  if (trap) {
    x.save(); x.clip();
    for (let i = -10; i < 20; i++) { x.fillStyle = i % 2 ? "#16161c" : "#ffd23f"; x.beginPath(); x.moveTo(i * 26, 0); x.lineTo(i * 26 + 26, 0); x.lineTo(i * 26 - 230, S); x.lineTo(i * 26 - 256, S); x.fill(); }
    x.restore();
  } else { x.fillStyle = RIM[c.owner]; x.fill(); }
  // поле с лучами
  const fill = FILL[c.act] || "#eee";
  x.save();
  x.beginPath(); x.arc(cx, cy, 98, 0, Math.PI * 2); x.clip();
  rays(x, cx, cy, 100, fill, shade(fill, 0.86));
  dots(x, cx, cy, 98, "rgba(0,0,0,.08)");
  x.restore();
  x.lineWidth = 5; x.strokeStyle = "#16161c";
  x.beginPath(); x.arc(cx, cy, 98, 0, Math.PI * 2); x.stroke();
  // подписи по бортику
  x.fillStyle = trap ? "#fff" : "#fff";
  if (trap) { x.shadowColor = "#000"; x.shadowBlur = 4; }
  arcText(x, (c.name || WORD[c.act] || "").toUpperCase().slice(0, 16), cx, cy, 112, true, 19);
  arcText(x, WORD[c.act] || c.act, cx, cy, 112, false, 17);
  x.shadowBlur = 0;
  // значок и число
  icon(x, c.act, cx, cy - 4, 120);
  const num = c.act === "double" ? "×2" : c.act === "dodge" || c.act === "stun" || c.act === "knock" ? "" : String(c.n);
  if (num) {
    x.font = `${num.length > 1 ? 58 : 70}px ${FONT}`;
    x.textAlign = "center"; x.textBaseline = "middle";
    x.lineWidth = 10; x.strokeStyle = "#16161c"; x.lineJoin = "round";
    x.strokeText(num, cx, cy + 2);
    x.fillStyle = c.act === "hit" ? "#e2312b" : c.act === "trap" ? "#16161c" : "#16161c";
    if (c.act === "trap") { x.fillStyle = "#e2312b"; }
    x.fillText(num, cx, cy + 2);
  }
  if (c.times && c.times > 1) {
    x.beginPath(); x.arc(cx + 62, cy + 54, 24, 0, Math.PI * 2);
    x.fillStyle = "#16161c"; x.fill();
    x.fillStyle = "#ffd23f"; x.font = `26px ${FONT}`; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText(`×${c.times}`, cx + 62, cy + 55);
  }
  gloss(x, cx, cy, 126);
  x.lineWidth = 4; x.strokeStyle = "#16161c";
  x.beginPath(); x.arc(cx, cy, 125, 0, Math.PI * 2); x.stroke();
  faces.set(key, cv);
  return cv;
}

const backs = new Map<string, HTMLCanvasElement>();

/** Рубашка: у твоих синяя, у вражьих красная, с вопросом. */
export function pogBack(owner: "hero" | "enemy"): HTMLCanvasElement {
  const hit = backs.get(owner);
  if (hit) return hit;
  const S = 256, cv = canvas(S), x = cv.getContext("2d")!;
  const cx = S / 2, cy = S / 2;
  const a = owner === "hero" ? "#1d6f8f" : "#b3262d", b = owner === "hero" ? "#145267" : "#7e1a20";
  x.beginPath(); x.arc(cx, cy, 126, 0, Math.PI * 2); x.fillStyle = "#16161c"; x.fill();
  x.save(); x.beginPath(); x.arc(cx, cy, 116, 0, Math.PI * 2); x.clip();
  rays(x, cx, cy, 130, a, b, 24);
  dots(x, cx, cy, 116, "rgba(255,255,255,.07)");
  x.restore();
  x.beginPath(); x.arc(cx, cy, 58, 0, Math.PI * 2); x.fillStyle = "#ffd23f"; x.fill();
  x.lineWidth = 6; x.strokeStyle = "#16161c"; x.stroke();
  x.fillStyle = "#16161c"; x.font = `${owner === "hero" ? 58 : 76}px ${FONT}`; x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText(owner === "hero" ? "КР" : "?", cx, cy + 4);
  x.fillStyle = "#fff";
  arcText(x, "КОМИКС-РОГАЛИК", cx, cy, 92, true, 18);
  arcText(x, owner === "hero" ? "ТВОЯ ФИШКА" : "ФИШКА ВРАГА", cx, cy, 92, false, 15);
  gloss(x, cx, cy, 126);
  backs.set(owner, cv);
  return cv;
}

/** Бортик фишки: картон с полосой цвета владельца. */
export function pogEdge(owner: "hero" | "enemy", trap = false): HTMLCanvasElement {
  const cv = canvas(64, 16), x = cv.getContext("2d")!;
  x.fillStyle = "#e9e1cd"; x.fillRect(0, 0, 64, 16);
  x.fillStyle = trap ? "#ffd23f" : RIM[owner]; x.fillRect(0, 4, 64, 8);
  x.fillStyle = "rgba(0,0,0,.35)"; x.fillRect(0, 0, 64, 1.5); x.fillRect(0, 14.5, 64, 1.5);
  return cv;
}

const SLAM: Record<string, [string, string]> = {
  fist: ["#c8302c", "#7a1714"], bat: ["#a8642c", "#5e3414"], knuckles: ["#b8bfc9", "#59606b"], crowbar: ["#d23a33", "#3b3f46"],
  stun_baton: ["#ffd23f", "#16161c"], umbrella: ["#6b4bb0", "#2e1f52"], skateboard: ["#2fb7a5", "#16161c"],
};

/** Верх битки: металл или пластик с названием. */
export function slammerTop(id: string, title: string): HTMLCanvasElement {
  const S = 256, cv = canvas(S), x = cv.getContext("2d")!;
  const cx = S / 2, cy = S / 2;
  const [a, b] = SLAM[id] || SLAM.fist;
  const g = x.createRadialGradient(cx - 40, cy - 50, 10, cx, cy, 130);
  g.addColorStop(0, shade(a.startsWith("#") ? a : "#888888", 1.35)); g.addColorStop(0.6, a); g.addColorStop(1, b);
  x.beginPath(); x.arc(cx, cy, 127, 0, Math.PI * 2); x.fillStyle = g; x.fill();
  for (let r = 118; r > 60; r -= 14) { x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.lineWidth = 2; x.strokeStyle = "rgba(0,0,0,.18)"; x.stroke(); }
  burst(x, cx, cy, 70, 10);
  x.fillStyle = "#16161c"; x.fill();
  x.fillStyle = "#ffd23f"; x.font = `${title.length > 6 ? 30 : 40}px ${FONT}`; x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText(title.toUpperCase().slice(0, 10), cx, cy + 2);
  x.fillStyle = "rgba(255,255,255,.85)";
  arcText(x, "БИТКА", cx, cy, 104, true, 20);
  gloss(x, cx, cy, 127);
  return cv;
}

export function slammerColors(id: string) { return SLAM[id] || SLAM.fist; }

/** Игровой коврик: сукно, круг под стопку, место для трофеев. */
export function matTexture(tower: [number, number], pile: [number, number], scale: number): HTMLCanvasElement {
  const W = 1024, H = 640, cv = canvas(W, H), x = cv.getContext("2d")!;
  const g = x.createRadialGradient(W * 0.45, H * 0.45, 40, W / 2, H / 2, W * 0.7);
  g.addColorStop(0, "#2f6b5a"); g.addColorStop(1, "#173a31");
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // ворс
  for (let i = 0; i < 9000; i++) {
    x.fillStyle = Math.random() < 0.5 ? "rgba(255,255,255,.025)" : "rgba(0,0,0,.05)";
    x.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }
  // края уходят в темноту: стол под лампой
  x.save();
  x.translate(W / 2, H / 2); x.scale(1, H / W);
  const v = x.createRadialGradient(0, 0, W * 0.2, 0, 0, W * 0.5);
  v.addColorStop(0, "rgba(16,21,18,0)"); v.addColorStop(0.85, "rgba(16,21,18,1)");
  x.fillStyle = v; x.fillRect(-W, -W, W * 2, W * 2);
  x.restore();
  const P = (p: [number, number]) => [W / 2 + p[0] * scale, H / 2 + p[1] * scale];
  const [tx, ty] = P(tower);
  x.setLineDash([14, 10]); x.lineWidth = 5; x.strokeStyle = "rgba(255,235,170,.4)";
  x.beginPath(); x.arc(tx, ty, scale * 1.35, 0, Math.PI * 2); x.stroke();
  const [px, py] = P(pile);
  x.beginPath(); x.arc(px, py, scale * 1.3, 0, Math.PI * 2); x.stroke();
  x.setLineDash([]);
  x.fillStyle = "rgba(255,235,170,.5)"; x.font = `600 ${Math.round(scale * 0.34)}px Rubik, sans-serif`; x.textAlign = "center";
  x.fillText("СТОПКА", tx, ty + scale * 1.75);
  x.fillText("ТВОИ ТРОФЕИ", px, py + scale * 1.7);
  return cv;
}
