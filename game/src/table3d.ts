// 3D-стол для боя: настоящие фишки с печатью и толщиной, стопка рубашкой вверх, битка падает
// на стопку, перевёрнутые фишки разлетаются и ложатся лицом вверх, вражьи уезжают в трофеи.
// Логика боя остаётся в chips.ts, здесь только картинка.

import {
  AmbientLight, CanvasTexture, CylinderGeometry, DirectionalLight, Group, HemisphereLight, Mesh,
  MeshStandardMaterial, PCFShadowMap, PerspectiveCamera, PlaneGeometry, SRGBColorSpace, Scene, Vector3,
  WebGLRenderer, Color, type Texture,
} from "three";
import type { Chip } from "./chips";
import { matTexture, pogBack, pogEdge, pogFace, slammerColors, slammerTop } from "./pogart";

const R = 1;            // радиус фишки
const T = 0.13;         // толщина фишки
const TOWER: [number, number] = [-2.9, -0.4];
const PILE: [number, number] = [4.9, 0.9];
const REST: [number, number] = [-5.9, 1.9];
const SPOTS: [number, number][] = [
  [-0.4, -1.3], [1.8, -1.6], [0.6, 0.8], [2.9, 0.4], [-1.0, 2.0], [1.6, 2.4], [3.9, -1.6], [-0.9, -3.0], [2.6, -3.3],
];

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeIn = (t: number) => t * t * t;
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

interface Pose { x: number; y: number; z: number; flip: number; spin: number; tilt: number }
interface Pog { mesh: Mesh; chip: Chip; pose: Pose; mats: MeshStandardMaterial[]; where: "tower" | "spot" | "pile" | "gone" }

export function webglOk(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return false; }
}

export class PogTable {
  readonly el: HTMLElement;
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(34, 2.4, 0.1, 100);
  private pogs = new Map<number, Pog>();
  private geo = new CylinderGeometry(R, R, T, 48, 1);
  private textures: Texture[] = [];
  private slammer: Group;
  private slamPose: Pose = { x: REST[0], y: 0.18, z: REST[1], flip: 0, spin: 0.4, tilt: 0 };
  private labels: HTMLElement;
  private raf = 0;
  private shake = 0;
  private glow = new Map<number, number>();
  private intent = -1;
  private disposed = false;
  private seen = false;
  private spotsUsed = new Set<number>();

  constructor(slammerId: string, slammerTitle: string) {
    this.el = document.createElement("div");
    this.el.className = "table3d";
    this.labels = document.createElement("div");
    this.labels.className = "t3-labels";
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.domElement.setAttribute("role", "img");
    this.renderer.domElement.setAttribute("aria-label", "Стол с фишками");
    this.el.append(this.renderer.domElement, this.labels);

    this.scene.background = new Color("#101512");

    this.scene.add(new HemisphereLight("#fff3dc", "#22303a", 0.9));
    this.scene.add(new AmbientLight("#ffffff", 0.25));
    const sun = new DirectionalLight("#ffffff", 2.1);
    sun.position.set(-5, 14, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 8, bottom: -8, near: 1, far: 40 });
    sun.shadow.bias = -0.0008;
    this.scene.add(sun);

    const matTex = this.tex(matTexture(TOWER, PILE, 1024 / 36));
    const mat = new Mesh(new PlaneGeometry(36, 24), new MeshStandardMaterial({ map: matTex, roughness: 0.95 }));
    mat.rotation.x = -Math.PI / 2;
    mat.receiveShadow = true;
    this.scene.add(mat);
    // тёмный пол вокруг коврика, чтобы не было видно края
    const floor = new Mesh(new PlaneGeometry(220, 220), new MeshStandardMaterial({ color: "#101512", roughness: 1 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.01;
    this.scene.add(floor);

    // битка: толстая тяжёлая фишка
    const [c1, c2] = slammerColors(slammerId);
    const sGeo = new CylinderGeometry(R * 1.08, R * 1.08, 0.34, 56, 1);
    const side = new MeshStandardMaterial({ color: c2, metalness: 0.6, roughness: 0.35 });
    const top = new MeshStandardMaterial({ map: this.tex(slammerTop(slammerId, slammerTitle)), metalness: 0.45, roughness: 0.3 });
    const bottom = new MeshStandardMaterial({ color: c1, metalness: 0.5, roughness: 0.4 });
    const sMesh = new Mesh(sGeo, [side, top, bottom]);
    sMesh.castShadow = true;
    this.slammer = new Group();
    this.slammer.add(sMesh);
    this.scene.add(this.slammer);

    new ResizeObserver(() => this.resize()).observe(this.el);
    const loop = () => {
      if (this.disposed) return;
      // окно боя закрыли не через конец боя (новый выпуск): прибираемся сами
      if (this.el.isConnected) this.seen = true;
      else if (this.seen) return this.dispose();
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private tex(c: HTMLCanvasElement) {
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    this.textures.push(t);
    return t;
  }

  private resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // на узком экране отъезжаем, чтобы весь стол влез
    const k = Math.max(1, 2.4 / this.camera.aspect);
    this.camera.position.set(-0.3, 6.6 * k, 9.4 * k);
    this.camera.lookAt(0, 1.2, -0.3);
    this.camera.updateProjectionMatrix();
  }

  private apply(m: Group | Mesh, p: Pose) {
    m.position.set(p.x, p.y, p.z);
    m.rotation.set(p.flip, p.spin, p.tilt, "YXZ");
  }

  private frame() {
    const now = performance.now();
    for (const pg of this.pogs.values()) {
      this.apply(pg.mesh, pg.pose);
      const g = this.glow.get(pg.chip.id) || 0;
      const pulse = pg.chip.id === this.intent ? 0.35 + 0.25 * Math.sin(now / 220) : 0;
      const side = pg.mats[0];
      if (pulse) side.emissive.set("#ff3b30");
      else if (g) side.emissive.set("#ffd23f");
      side.emissiveIntensity = Math.max(pulse, g);
      for (const m of pg.mats.slice(1)) { m.emissive.set("#ffd23f"); m.emissiveIntensity = g * 0.35; }
    }
    this.apply(this.slammer, this.slamPose);
    const cam = this.camera.position.clone();
    if (this.shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= 0.86;
      if (this.shake < 0.01) this.shake = 0;
    }
    this.renderer.render(this.scene, this.camera);
    this.camera.position.copy(cam);
  }

  private tween(ms: number, fn: (t: number) => void) {
    return new Promise<void>((ok) => {
      const t0 = performance.now();
      const step = (now: number) => {
        if (this.disposed) return ok();
        const t = Math.min(1, (now - t0) / ms);
        fn(t);
        if (t < 1) requestAnimationFrame(step); else ok();
      };
      requestAnimationFrame(step);
    });
  }

  private make(c: Chip): Pog {
    const side = new MeshStandardMaterial({ map: this.tex(pogEdge(c.owner, c.act === "trap")), roughness: 0.8 });
    const back = new MeshStandardMaterial({ map: this.tex(pogBack(c.owner)), roughness: 0.42 });
    const face = new MeshStandardMaterial({ map: this.tex(pogFace(c)), roughness: 0.38 });
    const mesh = new Mesh(this.geo, [side, back, face]);
    mesh.castShadow = true; mesh.receiveShadow = true;
    this.scene.add(mesh);
    const pg: Pog = { mesh, chip: c, mats: [side, back, face], where: "tower", pose: { x: TOWER[0], y: 8, z: TOWER[1], flip: 0, spin: Math.random() * 6, tilt: 0 } };
    this.pogs.set(c.id, pg);
    return pg;
  }

  private towerPose(i: number, n: number, pg: Pog): Pose {
    // чуть неровная стопка, как настоящая
    const j = ((pg.chip.id * 37) % 11) / 11 - 0.5;
    return { x: TOWER[0] + j * 0.12, y: T / 2 + (n - 1 - i) * T, z: TOWER[1] + (((pg.chip.id * 53) % 7) / 7 - 0.5) * 0.12, flip: 0, spin: pg.pose.spin, tilt: 0 };
  }

  private pilePose(i: number, pg: Pog): Pose {
    const j = ((pg.chip.id * 29) % 9) / 9 - 0.5;
    return { x: PILE[0] + j * 0.35, y: T / 2 + i * T, z: PILE[1] + (((pg.chip.id * 17) % 7) / 7 - 0.5) * 0.35, flip: Math.PI, spin: pg.pose.spin, tilt: 0 };
  }

  /** Перевести все фишки в положения по состоянию боя. */
  async arrange(stack: Chip[], captured: Chip[], ms = 520) {
    const moves: { pg: Pog; from: Pose; to: Pose; arc: number }[] = [];
    const keep = new Set<number>();
    stack.forEach((c, i) => {
      const pg = this.pogs.get(c.id) || this.make(c);
      keep.add(c.id);
      const to = this.towerPose(i, stack.length, pg);
      const far = pg.where !== "tower";
      if (far) to.flip = pg.pose.flip > Math.PI / 2 ? Math.PI * 2 : 0;  // лицом вниз обратно
      moves.push({ pg, from: { ...pg.pose }, to, arc: far ? 2.2 + i * 0.05 : 0 });
      pg.where = "tower";
    });
    captured.forEach((c, i) => {
      const pg = this.pogs.get(c.id) || this.make(c);
      keep.add(c.id);
      const to = this.pilePose(i, pg);
      moves.push({ pg, from: { ...pg.pose }, to, arc: pg.where === "pile" ? 0 : 2 });
      pg.where = "pile";
    });
    for (const pg of this.pogs.values()) {
      if (keep.has(pg.chip.id) || pg.where === "gone") continue;
      // фишка ушла из боя (вещь выбили): улетает со стола
      moves.push({ pg, from: { ...pg.pose }, to: { ...pg.pose, x: pg.pose.x - 14, y: 4, spin: pg.pose.spin + 6 }, arc: 2 });
      pg.where = "gone";
    }
    this.spotsUsed.clear();
    await this.tween(ms, (t) => {
      const e = ease(t);
      for (const m of moves) {
        const p = m.pg.pose;
        p.x = m.from.x + (m.to.x - m.from.x) * e;
        p.z = m.from.z + (m.to.z - m.from.z) * e;
        p.y = m.from.y + (m.to.y - m.from.y) * e + Math.sin(Math.PI * e) * m.arc;
        p.flip = m.from.flip + (m.to.flip - m.from.flip) * e;
        p.spin = m.from.spin + (m.to.spin - m.from.spin) * e;
        p.tilt = m.from.tilt * (1 - e);
      }
    });
    for (const m of moves) {
      if (m.pg.where === "gone") { this.scene.remove(m.pg.mesh); this.pogs.delete(m.pg.chip.id); }
      if (m.to.flip === Math.PI * 2) m.pg.pose.flip = 0;
    }
  }

  setIntent(id: number) { this.intent = id; }

  /** Подсветка фишек, которые перевернёт удар: яркость по шансу. */
  preview(stack: Chip[], chances: number[] | null) {
    this.glow.clear();
    if (chances) stack.forEach((c, i) => { if (chances[i] > 0) this.glow.set(c.id, 0.15 + chances[i] * 0.55); });
  }

  /** Удар биткой: падает на стопку, перевёрнутые фишки разлетаются лицом вверх. */
  async slam(ids: number[], strong: boolean, onImpact?: () => void) {
    this.glow.clear();
    const top = [...this.pogs.values()].filter((p) => p.where === "tower").reduce((m, p) => Math.max(m, p.pose.y), 0);
    const from = { ...this.slamPose };
    const above: Pose = { x: TOWER[0] + 0.1, y: top + (strong ? 2.3 : 1.7), z: TOWER[1] + 0.35, flip: -0.25, spin: from.spin + 1.2, tilt: 0.1 };
    await this.tween(360, (t) => {
      const e = easeOut(t), p = this.slamPose;
      p.x = from.x + (above.x - from.x) * e; p.z = from.z + (above.z - from.z) * e;
      p.y = from.y + (above.y - from.y) * e + Math.sin(Math.PI * t) * 1.2;
      p.flip = from.flip + (above.flip - from.flip) * e; p.spin = from.spin + (above.spin - from.spin) * e; p.tilt = above.tilt * e;
    });
    await wait(strong ? 160 : 90);
    const hitY = top + T / 2 + 0.17;
    await this.tween(strong ? 170 : 210, (t) => {
      const e = easeIn(t), p = this.slamPose;
      p.y = above.y + (hitY - above.y) * e;
      p.flip = above.flip * (1 - e); p.tilt = above.tilt * (1 - e);
    });
    this.shake = strong ? 0.55 : 0.3;
    onImpact?.();
    // разлёт
    const flying = ids.map((id) => this.pogs.get(id)).filter(Boolean) as Pog[];
    const rest = [...this.pogs.values()].filter((p) => p.where === "tower" && !ids.includes(p.chip.id)).sort((a, b) => b.pose.y - a.pose.y);
    const jobs = flying.map((pg, k) => {
      const s = this.freeSpot(k);
      const from = { ...pg.pose };
      const turns = 1 + Math.floor(Math.random() * 2);  // нечётное число полуоборотов: лицом вверх
      // ложится лицом к игроку, чуть вкось, как настоящая
      const up = -Math.PI / 2, loops = Math.ceil((from.spin + 2 - up) / (Math.PI * 2));
      const to: Pose = { x: s[0] + (Math.random() - 0.5) * 0.5, y: T / 2, z: s[1] + (Math.random() - 0.5) * 0.5, flip: Math.PI * (2 * turns - 1), spin: up + loops * Math.PI * 2 + (Math.random() - 0.5) * 0.7, tilt: 0 };
      const apex = 2.2 + Math.random() * 1.8 + (strong ? 1 : 0);
      const dur = 620 + Math.random() * 260;
      pg.where = "spot";
      return wait(k * 45).then(() => this.tween(dur, (t) => {
        const p = pg.pose, e = easeOut(t);
        p.x = from.x + (to.x - from.x) * e;
        p.z = from.z + (to.z - from.z) * e;
        p.y = from.y + (to.y - from.y) * t + Math.sin(Math.PI * t) * apex;
        p.flip = from.flip + (to.flip - from.flip) * easeOut(t);
        p.spin = from.spin + (to.spin - from.spin) * t;
        p.tilt = Math.sin(Math.PI * t) * 0.6;
      })).then(() => this.bounce(pg.pose));
    });
    // оставшаяся стопка оседает, битка отскакивает в сторону
    const drop = this.tween(320, (t) => {
      rest.forEach((pg, i) => {
        const target = T / 2 + (rest.length - 1 - i) * T;
        pg.pose.y += (target - pg.pose.y) * easeOut(t);
      });
    });
    const back = (async () => {
      await wait(120);
      const a = { ...this.slamPose };
      const to: Pose = { x: REST[0], y: 0.18, z: REST[1], flip: 0, spin: a.spin + 2, tilt: 0 };
      await this.tween(700, (t) => {
        const p = this.slamPose, e = ease(t);
        p.x = a.x + (to.x - a.x) * e; p.z = a.z + (to.z - a.z) * e;
        p.y = a.y + (to.y - a.y) * e + Math.sin(Math.PI * t) * 2.4;
        p.spin = a.spin + (to.spin - a.spin) * e; p.tilt = Math.sin(Math.PI * t) * 0.5;
      });
    })();
    await Promise.all([...jobs, drop]);
    void back;
  }

  private bounce(p: Pose) {
    const y0 = p.y;
    return this.tween(160, (t) => { p.y = y0 + Math.sin(Math.PI * t) * 0.18; });
  }

  private freeSpot(k: number): [number, number] {
    for (let i = 0; i < SPOTS.length; i++) {
      const s = (i + k * 3) % SPOTS.length;
      if (!this.spotsUsed.has(s)) { this.spotsUsed.add(s); return SPOTS[s]; }
    }
    return [Math.random() * 6 - 1, Math.random() * 4 - 2];
  }

  /** Сработала твоя фишка: подпрыгивает и светится. */
  async pulse(id: number) {
    const pg = this.pogs.get(id);
    if (!pg) return;
    const y0 = pg.pose.y;
    this.glow.set(id, 1);
    await this.tween(300, (t) => { pg.pose.y = y0 + Math.sin(Math.PI * t) * 0.7; pg.pose.tilt = Math.sin(Math.PI * 2 * t) * 0.15; });
    this.glow.set(id, 0.25);
  }

  /** Захват: вражья фишка уезжает в трофеи. */
  async capture(id: number, index: number) {
    const pg = this.pogs.get(id);
    if (!pg) return;
    const from = { ...pg.pose }, to = this.pilePose(index, pg);
    pg.where = "pile";
    await this.tween(480, (t) => {
      const e = ease(t), p = pg.pose;
      p.x = from.x + (to.x - from.x) * e; p.z = from.z + (to.z - from.z) * e;
      p.y = from.y + (to.y - from.y) * e + Math.sin(Math.PI * t) * 1.6;
      p.spin = from.spin + (to.spin - from.spin) * e;
    });
  }

  /** Ловушка: фишка дёргается красным, стол трясёт. */
  async trap(id: number) {
    const pg = this.pogs.get(id);
    this.shake = 0.45;
    if (!pg) return;
    pg.mats[0].emissive.set("#ff3b30");
    const x0 = pg.pose.x;
    await this.tween(360, (t) => { pg.pose.x = x0 + Math.sin(t * Math.PI * 8) * 0.12 * (1 - t); });
  }

  /** Ход врага: его фишка выезжает из стопки и бьёт. */
  async enemy(id?: number) {
    const pg = id ? this.pogs.get(id) : undefined;
    if (pg && pg.where === "tower") {
      const from = { ...pg.pose };
      await this.tween(380, (t) => {
        const k = Math.sin(Math.PI * t);
        pg.pose.z = from.z + k * 1.8; pg.pose.y = from.y + k * 0.6; pg.pose.tilt = k * 0.3;
      });
    }
    this.shake = 0.4;
  }

  /** Подпись над фишкой («−3», «ЦАП!»), всплывает и гаснет. */
  label(id: number | null, text: string, cls = "") {
    const pg = id !== null ? this.pogs.get(id) : undefined;
    const v = pg ? new Vector3(pg.pose.x, pg.pose.y + 0.6, pg.pose.z) : new Vector3(TOWER[0], 2.4, TOWER[1]);
    v.project(this.camera);
    const el = document.createElement("span");
    el.className = `t3-label ${cls}`;
    el.textContent = text;
    el.style.left = `${((v.x + 1) / 2) * 100}%`;
    el.style.top = `${((1 - v.y) / 2) * 100}%`;
    this.labels.append(el);
    setTimeout(() => el.remove(), 1300);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const t of this.textures) t.dispose();
    this.geo.dispose();
    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        if (m.geometry !== this.geo) m.geometry.dispose();
        for (const mat of ([] as MeshStandardMaterial[]).concat(m.material as MeshStandardMaterial)) mat.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
