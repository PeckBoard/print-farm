// three.js viewers: a model viewer (STL / 3MF, orbit + fit + build plate) and
// a G-code layer viewer (extrusion vs travel, layer slider). Both share one
// renderer per container.

import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  AmbientLight,
  DirectionalLight,
  HemisphereLight,
  GridHelper,
  Mesh,
  MeshStandardMaterial,
  BufferGeometry,
  Float32BufferAttribute,
  LineSegments,
  LineBasicMaterial,
  Group,
  Box3,
  Vector3,
  Color,
  Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import type { ParsedGcode } from "./gcode";

export interface ViewerTheme {
  bg: string;
  grid: string;
  gridMinor: string;
  model: string;
  extrude: string;
  extrudeTop: string;
  travel: string;
}

export class Viewer {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(40, 1, 0.1, 10000);
  private controls: OrbitControls;
  private content = new Group();
  private grid: GridHelper | null = null;
  private ro: ResizeObserver;
  private raf = 0;
  private gcode: {
    parsed: ParsedGcode;
    group: Group;
    lines: LineSegments[];
    travel: LineSegments[];
    exMat: LineBasicMaterial;
    topMat: LineBasicMaterial;
  } | null = null;
  private showTravel = false;
  private bed = 220;

  constructor(private host: HTMLElement, private theme: ViewerTheme) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    // Z-up like a printer.
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener("change", () => this.kick());
    this.scene.add(new HemisphereLight(0xffffff, 0x444444, 1.4));
    this.scene.add(new AmbientLight(0xffffff, 0.35));
    const d = new DirectionalLight(0xffffff, 1.6);
    d.position.set(1, -1.4, 2);
    this.scene.add(d);
    this.scene.add(this.content);
    this.applyTheme(theme);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
  }

  applyTheme(t: ViewerTheme) {
    this.theme = t;
    this.scene.background = new Color(t.bg);
    this.buildGrid(this.bed);
    this.kick();
  }

  private buildGrid(size: number) {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
    }
    const div = Math.max(4, Math.round(size / 10));
    const g = new GridHelper(size, div, new Color(this.theme.grid), new Color(this.theme.gridMinor));
    g.rotation.x = Math.PI / 2; // XZ → XY plane
    g.position.set(size / 2, size / 2, 0);
    this.grid = g;
    this.scene.add(g);
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.kick();
  }

  /// Render on demand (damping needs a few frames after input).
  private kick() {
    if (this.raf) return;
    let frames = 30;
    const loop = () => {
      this.raf = 0;
      const moved = this.controls.update();
      this.renderer.render(this.scene, this.camera);
      if (moved || --frames > 0) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private clear() {
    for (const child of [...this.content.children]) {
      this.content.remove(child);
      disposeTree(child);
    }
    this.gcode = null;
  }

  showStl(buf: ArrayBuffer) {
    const geo = new STLLoader().parse(buf);
    geo.computeVertexNormals();
    const mesh = new Mesh(geo, new MeshStandardMaterial({ color: new Color(this.theme.model), roughness: 0.55, metalness: 0.05 }));
    this.placeModel(mesh);
  }

  show3mf(buf: ArrayBuffer) {
    const group = new ThreeMFLoader().parse(buf) as unknown as Object3D;
    // 3MF materials are often flat white; give everything the theme colour.
    group.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) m.material = new MeshStandardMaterial({ color: new Color(this.theme.model), roughness: 0.55, metalness: 0.05 });
    });
    this.placeModel(group);
  }

  /// Center the model on the plate, resting on Z=0.
  private placeModel(obj: Object3D) {
    this.clear();
    const box = new Box3().setFromObject(obj);
    const size = box.getSize(new Vector3());
    const plate = Math.max(220, Math.ceil((Math.max(size.x, size.y) * 1.3) / 10) * 10);
    this.bed = plate;
    this.buildGrid(plate);
    const c = box.getCenter(new Vector3());
    obj.position.set(plate / 2 - c.x, plate / 2 - c.y, -box.min.z);
    this.content.add(obj);
    this.fit();
  }

  showGcode(parsed: ParsedGcode) {
    this.clear();
    const group = new Group();
    const lines: LineSegments[] = [];
    const travel: LineSegments[] = [];
    const exMat = new LineBasicMaterial({ color: new Color(this.theme.extrude) });
    const trMat = new LineBasicMaterial({ color: new Color(this.theme.travel), transparent: true, opacity: 0.55 });
    for (const layer of parsed.layers) {
      const eg = new BufferGeometry();
      eg.setAttribute("position", new Float32BufferAttribute(layer.extrude, 3));
      const el = new LineSegments(eg, exMat);
      group.add(el);
      lines.push(el);
      const tg = new BufferGeometry();
      tg.setAttribute("position", new Float32BufferAttribute(layer.travel, 3));
      const tl = new LineSegments(tg, trMat);
      tl.visible = false;
      group.add(tl);
      travel.push(tl);
    }
    this.content.add(group);
    this.gcode = { parsed, group, lines, travel, exMat, topMat: new LineBasicMaterial({ color: new Color(this.theme.extrudeTop) }) };
    const b = parsed.bounds;
    const plate = b ? Math.max(220, Math.ceil(Math.max(b.max[0], b.max[1]) / 10) * 10) : 220;
    this.bed = plate;
    this.buildGrid(plate);
    this.setLayer(parsed.layers.length - 1);
    this.fit();
  }

  /// Show layers 0..n; the top layer is highlighted, travel shown for it only.
  setLayer(n: number) {
    const g = this.gcode;
    if (!g) return;
    g.lines.forEach((l, i) => {
      l.visible = i <= n;
      l.material = i === n ? g.topMat : g.exMat;
    });
    g.travel.forEach((l, i) => (l.visible = this.showTravel && i === n));
    this.kick();
  }

  setShowTravel(on: boolean, layer: number) {
    this.showTravel = on;
    this.setLayer(layer);
  }

  fit() {
    const box = new Box3().setFromObject(this.content);
    if (box.isEmpty()) {
      box.set(new Vector3(0, 0, 0), new Vector3(this.bed, this.bed, 10));
    }
    const c = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const r = Math.max(size.x, size.y, size.z, 10) * 0.6;
    const dist = r / Math.sin((this.camera.fov * Math.PI) / 360);
    this.camera.position.set(c.x + dist * 0.55, c.y - dist * 0.75, c.z + dist * 0.6);
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
    this.kick();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.clear();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function disposeTree(o: Object3D) {
  o.traverse((c) => {
    const m = c as Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as any;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat && mat.dispose) mat.dispose();
  });
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch (_e) {
    return false;
  }
}
