import {
  AmbientLight, DirectionalLight, HemisphereLight, Mesh, PCFShadowMap, PerspectiveCamera, PlaneGeometry,
  Scene, ShadowMaterial, Vector3, WebGLRenderer,
} from 'three';
import { Character, type DebugPass, type Inspection, PARTICLE_LAYER } from './character.js';
import { authoredFor } from './overrides.js';
import { poseFor } from './timeline.js';
import type { ClayStateId } from './states.js';

export interface RenderSpec {
  state: ClayStateId;
  /** Loop position, 0 <= t <= 1. */
  t: number;
  puffed: boolean;
  /** Body colour "#rrggbb". */
  colour: string;
  shadows: boolean;
}

export type StageCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Counts real 3D renders, so tests can prove bake-mode playback does none. */
export const renderStats = { renders: 0 };

/**
 * One WebGL context, one scene, one character. The baker, live mode, the PC baker and the
 * snapshot tests all draw through it, so a frame depends only on its RenderSpec and size.
 */
export class Stage {
  readonly renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(24, 1, 0.1, 30);
  private character = new Character();
  private key = new DirectionalLight('#fff3e6', 2.4);
  private floor: Mesh;
  private size = 0;

  constructor(readonly canvas: StageCanvas) {
    this.renderer = new WebGLRenderer({
      canvas: canvas as HTMLCanvasElement, alpha: true, antialias: true, premultipliedAlpha: true,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.localClippingEnabled = true; // X3's battery charge is cut level by a clip plane
    this.renderer.shadowMap.type = PCFShadowMap;

    const hemi = new HemisphereLight('#ffffff', '#c9b8a8', 1.1), amb = new AmbientLight('#ffffff', 0.25);
    this.scene.add(hemi, amb);
    // soft key light from the upper left, and a cool fill from the right
    this.key.position.set(-2.4, 4.2, 3.4);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(512, 512);
    this.key.shadow.radius = 4;
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.02;
    const sc = this.key.shadow.camera;
    sc.left = -1.8; sc.right = 1.8; sc.top = 2.4; sc.bottom = -1.2; sc.near = 0.5; sc.far = 12;
    this.scene.add(this.key);
    const fill = new DirectionalLight('#dfe8ff', 0.5);
    fill.position.set(2.5, 1.5, 3);
    this.scene.add(fill);
    for (const l of [hemi, amb, this.key, fill]) l.layers.enable(PARTICLE_LAYER); // the particle test pass is lit alike

    this.floor = new Mesh(new PlaneGeometry(7, 7), new ShadowMaterial({ opacity: 0.28 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.scene.add(this.character.root);
    // framed so every prop (bubble, Zzz, steam, ice block, lying flat) stays inside a square frame
    this.camera.position.set(0, 1.4, 5.4);
    this.camera.lookAt(0, 0.85, 0);
  }

  /** Square render size in device pixels. Cheap when unchanged. */
  setSize(px: number): void {
    if (px === this.size) return;
    this.size = px;
    this.renderer.setSize(px, px, false);
    const map = px > 160 ? 1024 : 512;
    if (this.key.shadow.mapSize.x !== map) {
      this.key.shadow.mapSize.set(map, map);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
  }

  /** `debug`: a test pass (Character.setDebug); the board never passes one. */
  render(spec: RenderSpec, debug?: DebugPass): void {
    this.character.setDebug(debug);
    this.camera.layers.set(debug?.pass === 'particles' ? PARTICLE_LAYER : 0);
    this.character.apply({ ...poseFor(spec.state, spec.t, spec.puffed), ...debug?.pose }, spec.colour, authoredFor(spec.state));
    this.key.castShadow = spec.shadows;
    this.floor.visible = spec.shadows;
    this.renderer.render(this.scene, this.camera);
    renderStats.renders++;
  }

  /** What the character shows as last rendered (the pose editor's drag handles). */
  inspect(): Inspection { return this.character.inspect(); }

  /** Where world point `v` lands in the frame: x and y in 0..1 from the top left. */
  project(v: Vector3): { x: number; y: number } {
    const p = v.clone().project(this.camera);
    return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
  }

  /** The world offset that moves world point `v` by (dx, dy) of the frame (fractions of its width and height). */
  unprojectDelta(v: Vector3, dx: number, dy: number): Vector3 {
    const p = v.clone().project(this.camera);
    const q = new Vector3(p.x + 2 * dx, p.y - 2 * dy, p.z).unproject(this.camera);
    return q.sub(v);
  }

  /** True when the GL context was lost (the GPU process restarted or the tab was starved). */
  lost(): boolean { return this.renderer.getContext().isContextLost(); }

  dispose(): void {
    this.character.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
