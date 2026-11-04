// Звуки боя синтезом, без файлов: удар битки, щелчки фишек, захват, ловушка.

let ctx: AudioContext | null = null;
let on = true;
try { on = localStorage.getItem("comix.sound") !== "off"; } catch { /* приватный режим */ }

export const soundOn = () => on;
export function setSound(v: boolean) {
  on = v;
  try { localStorage.setItem("comix.sound", v ? "on" : "off"); } catch { /* ок */ }
}

function ac() {
  if (!on) return null;
  try {
    ctx ||= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch { return null; }
}

function noise(a: AudioContext, dur: number) {
  const b = a.createBuffer(1, Math.max(1, Math.floor(a.sampleRate * dur)), a.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = a.createBufferSource();
  s.buffer = b;
  return s;
}

function env(a: AudioContext, peak: number, dur: number, at = a.currentTime) {
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  g.connect(a.destination);
  return g;
}

/** Битка бьёт по стопке. */
export function thump(strong = false) {
  const a = ac(); if (!a) return;
  const o = a.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(strong ? 150 : 190, a.currentTime);
  o.frequency.exponentialRampToValueAtTime(45, a.currentTime + 0.18);
  o.connect(env(a, strong ? 0.7 : 0.5, 0.25));
  o.start(); o.stop(a.currentTime + 0.3);
  const n = noise(a, 0.12), f = a.createBiquadFilter();
  f.type = "lowpass"; f.frequency.value = 1800;
  n.connect(f); f.connect(env(a, 0.35, 0.1));
  n.start();
}

/** Картонная фишка падает на сукно. */
export function clack(delay = 0) {
  const a = ac(); if (!a) return;
  const at = a.currentTime + delay;
  const n = noise(a, 0.05), f = a.createBiquadFilter();
  f.type = "bandpass"; f.frequency.value = 2200 + Math.random() * 1200; f.Q.value = 1.4;
  n.connect(f); f.connect(env(a, 0.22, 0.05, at));
  n.start(at);
}

/** Сработала фишка или захват. */
export function blip(up = true) {
  const a = ac(); if (!a) return;
  const o = a.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(up ? 520 : 300, a.currentTime);
  o.frequency.exponentialRampToValueAtTime(up ? 980 : 160, a.currentTime + 0.12);
  o.connect(env(a, 0.16, 0.16));
  o.start(); o.stop(a.currentTime + 0.2);
}

/** Ловушка или удар врага. */
export function buzz() {
  const a = ac(); if (!a) return;
  const o = a.createOscillator();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(120, a.currentTime);
  o.frequency.linearRampToValueAtTime(70, a.currentTime + 0.25);
  const f = a.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 900;
  o.connect(f); f.connect(env(a, 0.25, 0.28));
  o.start(); o.stop(a.currentTime + 0.3);
}
