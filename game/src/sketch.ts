// Карандашный эскиз и тушь из готового цветного кадра: так выглядит кадр, пока игрок выбирает,
// и так он «прорисовывается» после выбора (эскиз -> тушь -> цвет).

const PAPER = [244, 239, 226];
const PENCIL = [66, 68, 80];
const INK = [18, 18, 24];
const INK_PAPER = [251, 249, 243];

export function sketchAndInk(src: HTMLCanvasElement): { sketch: HTMLCanvasElement; ink: HTMLCanvasElement } {
  const w = src.width, h = src.height;
  const d = src.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const L = new Float32Array(w * h);
  for (let i = 0, j = 0; j < L.length; i += 4, j++) L[j] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;

  const mk = () => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d")!;
    return { c, x, img: x.createImageData(w, h) };
  };
  const S = mk(), I = mk();
  const sd = S.img.data, id = I.img.data;
  const step = Math.max(5, Math.round(w / 90));  // шаг штриховки

  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : y, y1 = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : x, x1 = x < w - 1 ? x + 1 : x;
      const a = L[y0 * w + x0], b = L[y0 * w + x], c = L[y0 * w + x1];
      const e = L[y * w + x0], f = L[y * w + x1];
      const g = L[y1 * w + x0], hh = L[y1 * w + x], k = L[y1 * w + x1];
      const gx = c + 2 * f + k - a - 2 * e - g;
      const gy = g + 2 * hh + k - a - 2 * b - c;
      const G = Math.sqrt(gx * gx + gy * gy);
      const l = L[y * w + x];
      // эскиз: мягкие линии + штриховка в тенях
      let s = Math.min(1, G * 1.4) * 0.8;
      if (l < 0.5 && (x + y) % step === 0) s += 0.32;
      if (l < 0.28 && (x - y + 4096 * step) % step === 0) s += 0.3;
      s = Math.min(0.92, s);
      // тушь: резкие чёрные линии + заливка самых тёмных мест
      let t = G > 0.42 ? 1 : G > 0.22 ? (G - 0.22) / 0.2 : 0;
      if (l < 0.12) t = Math.max(t, 0.9);
      const o = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        sd[o + ch] = PAPER[ch] * (1 - s) + PENCIL[ch] * s;
        id[o + ch] = INK_PAPER[ch] * (1 - t) + INK[ch] * t;
      }
      sd[o + 3] = 255;
      id[o + 3] = 255;
    }
  }
  S.x.putImageData(S.img, 0, 0);
  I.x.putImageData(I.img, 0, 0);
  return { sketch: S.c, ink: I.c };
}
