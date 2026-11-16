import * as THREE from "three";

export interface AtmosphereOptions {
  skyColor: number;
  fogDensity: number;
}

const DEFAULT_ATMOSPHERE: AtmosphereOptions = { skyColor: 0xa9bfcc, fogDensity: 0.012 };

/** Owns the WebGL renderer, scene, camera, lights and fog. */
export class WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    atmosphere: AtmosphereOptions = DEFAULT_ATMOSPHERE,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Far plane sits just past full fog; chunk streaming radius covers it.
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 260);

    const sky = new THREE.Color(atmosphere.skyColor);
    this.scene.background = sky;
    this.scene.fog = new THREE.FogExp2(sky, atmosphere.fogDensity);

    // Warm key light + cool sky fill: strong facet contrast on flat-shaded hills.
    const hemi = new THREE.HemisphereLight(0xdfeeff, 0x4a3b28, 1.4);
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
    sun.position.set(-0.6, 1, -0.35);
    this.scene.add(hemi, sun);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  private resize(): void {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }
}
