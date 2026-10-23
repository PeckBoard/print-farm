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
  BufferAttribute,
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
import type { Parsed3mf } from "./threemf";
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
  private frames = 0;
  private gcode: {
    parsed: ParsedGcode;
    below: LineSegments;
    top: LineSegments;
    travel: LineSegments;
  } | null = null;
  /// WebGL is running on the CPU (see webglInfo).
  readonly software: boolean;
  private showTravel = false;
  private bed = 220;

  constructor(private host: HTMLElement, private theme: ViewerTheme) {
    const info = webglInfo();
    this.software = !!info?.software;
    // Ask for the discrete GPU, and don't keep a copy of every frame
    // (preserveDrawingBuffer forces a full-canvas copy per render). On a
    // CPU (software) renderer drop MSAA and render at 1x: it's the pixel
    // count that makes software WebGL crawl.
    this.renderer = new WebGLRenderer({ antialias: !this.software, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(this.software ? 1 : Math.min(2, window.devicePixelRatio || 1));
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    // Z-up like a printer.
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    // Default 0.05 keeps the camera drifting (and rendering) for seconds
    // after a drag; 0.15 settles in well under one.
    this.controls.dampingFactor = 0.15;
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
  /// Render on demand. One loop at most: input during a frame (OrbitControls
  /// fires "change" from update()) only extends it, and damping keeps it
  /// running exactly while the camera still moves.
  private kick() {
    this.frames = 2;
    if (this.raf) return;
    const loop = () => {
      const moved = this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = moved || --this.frames > 0 ? requestAnimationFrame(loop) : 0;
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

  /// A parsed 3MF (see threemf.ts): every object, or only those on `plate`.
  show3mf(parsed: Parsed3mf, plate: number | null = null) {
    const group = new Group();
    // Flat shading: project meshes share vertices across hard edges.
    const mat = new MeshStandardMaterial({ color: new Color(this.theme.model), roughness: 0.55, metalness: 0.05, flatShading: true });
    for (const o of parsed.objects) {
      if (plate !== null && o.plate !== plate) continue;
      for (const p of o.parts) {
        const geo = new BufferGeometry();
        geo.setAttribute("position", new BufferAttribute(p.positions, 3));
        geo.setIndex(new BufferAttribute(p.indices, 1));
        geo.computeVertexNormals();
        group.add(new Mesh(geo, mat));
      }
    }
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
    // One GPU buffer per kind; "layers 0..n" is a draw range, so the whole
    // print is three draw calls however many layers it has. `below` and
    // `top` share the extrusion buffer (uploaded once).
    const exAttr = new BufferAttribute(parsed.extrude, 3);
    const belowGeo = new BufferGeometry();
    belowGeo.setAttribute("position", exAttr);
    const topGeo = new BufferGeometry();
    topGeo.setAttribute("position", exAttr);
    const travelGeo = new BufferGeometry();
    travelGeo.setAttribute("position", new BufferAttribute(parsed.travel, 3));
    const below = new LineSegments(belowGeo, new LineBasicMaterial({ color: new Color(this.theme.extrude) }));
    const top = new LineSegments(topGeo, new LineBasicMaterial({ color: new Color(this.theme.extrudeTop) }));
    const travel = new LineSegments(travelGeo, new LineBasicMaterial({ color: new Color(this.theme.travel), transparent: true, opacity: 0.55 }));
    // Draw ranges change what's visible; skip per-frame bounds checks.
    for (const l of [below, top, travel]) l.frustumCulled = false;
    const group = new Group();
    group.add(below, top, travel);
    this.content.add(group);
    this.gcode = { parsed, below, top, travel };
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
    const L = g.parsed.layers[n];
    if (!L) {
      g.below.geometry.setDrawRange(0, 0);
      g.top.geometry.setDrawRange(0, 0);
      g.travel.geometry.setDrawRange(0, 0);
    } else {
      g.below.geometry.setDrawRange(0, L.e0 / 3);
      g.top.geometry.setDrawRange(L.e0 / 3, (L.e1 - L.e0) / 3);
      g.travel.geometry.setDrawRange(L.t0 / 3, (L.t1 - L.t0) / 3);
    }
    g.travel.visible = this.showTravel;
    this.kick();
  }

  setShowTravel(on: boolean, layer: number) {
    this.showTravel = on;
    this.setLayer(layer);
  }

  fit() {
    const b = this.gcode?.parsed.bounds;
    const box = b ? new Box3(new Vector3(...b.min), new Vector3(...b.max)) : new Box3().setFromObject(this.content);
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
    this.raf = 0;
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

export interface WebglInfo {
  /// The GPU string, when the browser exposes it.
  renderer: string;
  /// True when WebGL runs on the CPU (SwiftShader / llvmpipe / WARP): the
  /// browser's hardware acceleration is off or the GPU is blocklisted.
  software: boolean;
}

let probed: WebglInfo | null | undefined;

/// Probe WebGL once (asking for the discrete GPU), then free the context.
export function webglInfo(): WebglInfo | null {
  if (probed !== undefined) return probed;
  probed = null;
  try {
    const c = document.createElement("canvas");
    const opts = { powerPreference: "high-performance" as const };
    const gl = (c.getContext("webgl2", opts) || c.getContext("webgl", opts)) as WebGLRenderingContext | null;
    if (!gl) return probed;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String((dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || "");
    probed = { renderer, software: /swiftshader|llvmpipe|softpipe|software|basic render|warp/i.test(renderer) };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch (_e) {
    probed = null;
  }
  return probed;
}

export function webglAvailable(): boolean {
  return webglInfo() !== null;
}
