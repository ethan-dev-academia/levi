import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { Sky, clockTime, type SkyState } from "./Sky.js";

/** Everyday fog density, and how thin it gets when the view opens up. */
const FOG = 0.0042;
const FOG_OPEN = 0.0018;
/** Default far plane: past full fog; the horizon mesh fills in beyond the detailed chunks. */
const FAR = 440;
/** Half-size of the sun's shadow box around the player. */
const SHADOW_BOX = 45;

/** A gentle filmic grade: a touch more colour, warm lights / cool shade, soft vignette. */
const GradeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main() {
      vec4 t = texture2D(tDiffuse, vUv);
      vec3 c = t.rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, 1.12);
      c += mix(vec3(-0.012, 0.0, 0.026), vec3(0.026, 0.01, -0.018), smoothstep(0.12, 0.8, l));
      vec2 q = vUv - 0.5;
      c *= 1.0 - 0.3 * smoothstep(0.32, 0.85, length(q * vec2(1.1, 1.0)));
      gl_FragColor = vec4(c, t.a);
    }`,
};

/** Clears any invalid pixel (NaN/inf) before bloom, which would smear it over the whole screen. */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main() {
      vec4 t = texture2D(tDiffuse, vUv);
      bool bad = any(isnan(t)) || any(isinf(t));
      gl_FragColor = bad ? vec4(0.0, 0.0, 0.0, 1.0) : min(t, vec4(64.0));
    }`,
};

export type Quality = "high" | "low";
const QUALITY_KEY = "levi.quality";

/** Owns the WebGL renderer, scene, camera, sky, lights, fog and post effects. */
export class WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sky = new Sky();
  private readonly resizeObserver: ResizeObserver;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  private readonly fog: THREE.FogExp2;
  private readonly focus = new THREE.Vector3();
  private composer: EffectComposer | null = null;
  private ao: GTAOPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private openness = 0;
  private shadowCheck = 0;
  private skyTick = 0;
  private quality: Quality;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, FAR);

    this.fog = new THREE.FogExp2(0xc9dbe6, FOG);
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(this.sky.mesh);

    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -SHADOW_BOX;
    sc.right = sc.top = SHADOW_BOX;
    sc.near = 1;
    sc.far = 420;
    sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3;
    this.scene.add(this.hemi, sun, sun.target);

    let q: Quality = "high";
    try {
      if (localStorage.getItem(QUALITY_KEY) === "low") q = "low";
    } catch {
      /* storage blocked: default quality */
    }
    this.quality = q;
    this.applyQuality();
    this.updateSky(true);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  get graphics(): Quality {
    return this.quality;
  }

  /** "high": ambient occlusion, bloom and soft shadows. "low": plain render, hard shadows. */
  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    try {
      localStorage.setItem(QUALITY_KEY, q);
    } catch {
      /* storage blocked: applies this session only */
    }
    this.applyQuality();
    this.resize();
  }

  private applyQuality(): void {
    this.composer?.dispose();
    this.composer = null;
    this.ao = null;
    this.bloom = null;
    const high = this.quality === "high";
    this.sun.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    if (!high) return;
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    const ao = new GTAOPass(this.scene, this.camera, 512, 512);
    // Faces are flat-shaded (no stored normals): render the normal buffer faceted too.
    (ao as unknown as { normalMaterial: THREE.MeshNormalMaterial }).normalMaterial.flatShading = true;
    ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.6, thickness: 1.4, scale: 1.1, samples: 12 });
    ao.blendIntensity = 0.8;
    // Leave see-through things (faded roofs, glows, the sky) out of the AO buffers.
    const pass = ao as unknown as { overrideVisibility(): void; _visibilityCache: Map<THREE.Object3D, boolean> };
    pass.overrideVisibility = () => {
      this.scene.traverse((o) => {
        pass._visibilityCache.set(o, o.visible);
        const m = o as THREE.Mesh;
        if ((o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite) o.visible = false;
        else if (m.isMesh) {
          const mat = m.material as THREE.Material;
          if (o === this.sky.mesh || (mat && !Array.isArray(mat) && mat.transparent && mat.opacity < 0.99)) o.visible = false;
        }
      });
    };
    if (!(import.meta.env.DEV && location.search.includes("noao"))) composer.addPass(ao);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.55, 0.86);
    composer.addPass(new ShaderPass(SanitizeShader));
    if (!(import.meta.env.DEV && location.search.includes("nobloom"))) composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    if (!(import.meta.env.DEV && location.search.includes("nograde"))) composer.addPass(new ShaderPass(GradeShader));
    this.composer = composer;
    this.ao = ao;
  }

  private resize(): void {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      const pr = this.renderer.getPixelRatio();
      this.composer.setSize(w, h);
      // AO at half resolution: soft anyway, and much cheaper.
      this.ao?.setSize(Math.ceil((w * pr) / 2), Math.ceil((h * pr) / 2));
    }
  }

  /** Current sky and light state (time of day, how dark it is). */
  get skyState(): SkyState {
    return this.sky.state;
  }

  private updateSky(force = false): void {
    // The sky moves slowly: a few updates a second is plenty.
    if (!force && --this.skyTick > 0) return;
    this.skyTick = 10;
    const st = this.sky.set(clockTime());
    this.hemi.color.copy(st.hemiSky);
    this.hemi.groundColor.copy(st.hemiGround);
    this.hemi.intensity = st.hemiIntensity;
    this.sun.color.copy(st.lightColor);
    this.sun.intensity = st.lightIntensity;
    this.fog.color.copy(st.horizon);
    this.renderer.toneMappingExposure = st.exposure;
    if (this.bloom) this.bloom.strength = 0.3 + st.night * 0.55;
    this.placeSun();
  }

  /** Where the player is: the sun's shadow box follows them. */
  setFocus(x: number, y: number, z: number): void {
    this.focus.set(x, y, z);
    this.placeSun();
  }

  private placeSun(): void {
    // Snap to shadow texels so shadows don't shimmer as you walk.
    const texel = (SHADOW_BOX * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(this.focus.x / texel) * texel;
    const fz = Math.round(this.focus.z / texel) * texel;
    const d = this.sky.state.lightDir;
    this.sun.target.position.set(fx, this.focus.y, fz);
    this.sun.position.set(fx + d.x * 200, this.focus.y + d.y * 200, fz + d.z * 200);
  }

  /**
   * How far you can see: 0 = everyday, 1 = a cutscene looking across the
   * world (thin fog, distant far plane).
   */
  setOpenness(w: number): void {
    this.openness = w;
    this.fog.density = FOG + (FOG_OPEN - FOG) * w;
    const far = FAR + (1400 - FAR) * w;
    if (Math.abs(this.camera.far - far) > 0.5) {
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  render(): void {
    this.updateSky();
    this.sky.mesh.position.copy(this.camera.position);
    if (--this.shadowCheck <= 0) {
      this.shadowCheck = 30;
      flagShadows(this.scene);
    }
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.composer?.dispose();
    this.renderer.dispose();
  }
}

/** Groups whose meshes never cast shadows (sky, far land, water, clouds, effects). */
const NO_SHADOW = /^(sky|horizon|clouds|water|abyss|ambience|spell-fx|combat-fx|marker)/;

/** Solid meshes cast and take shadows; checked now and then as things stream in. */
function flagShadows(scene: THREE.Scene): void {
  const walk = (o: THREE.Object3D, skip: boolean): void => {
    const off = skip || NO_SHADOW.test(o.name);
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      const mat = m.material as THREE.Material | THREE.Material[];
      const first = Array.isArray(mat) ? mat[0] : mat;
      const solid = !!first && !(first as THREE.MeshBasicMaterial).isMeshBasicMaterial && !(first as THREE.ShaderMaterial).isShaderMaterial;
      const clear = !!first && first.transparent && first.opacity < 0.99;
      m.castShadow = !off && solid && !clear;
      m.receiveShadow = !off && solid;
    }
    for (const c of o.children) walk(c, off);
  };
  walk(scene, false);
}
