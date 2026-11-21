import * as THREE from "three";

/** One real hour is one day in the Layland. */
export const DAY_SECONDS = 3600;

/**
 * Time of day, 0..1 (0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset).
 * Everyone shares the real clock, so all players see the same sky. In dev,
 * `?time=0.3` pins the time (for screenshots and tuning).
 */
export function clockTime(): number {
  if (import.meta.env.DEV) {
    const q = new URLSearchParams(location.search).get("time");
    if (q !== null && q !== "" && !Number.isNaN(Number(q))) return ((Number(q) % 1) + 1) % 1;
  }
  return (Date.now() / 1000 / DAY_SECONDS) % 1;
}

interface Key {
  /** Sun elevation (sin) at this key. */
  e: number;
  zenith: number;
  horizon: number;
  glow: number;
  sun: number;
  sunI: number;
  hemiSky: number;
  hemiGround: number;
  hemiI: number;
  exposure: number;
}

// Keyed by the sun's elevation, low to high.
const KEYS: Key[] = [
  { e: -0.35, zenith: 0x060d1f, horizon: 0x16243f, glow: 0x4a5f9a, sun: 0x8fa6e6, sunI: 0.55, hemiSky: 0x34507f, hemiGround: 0x1a1712, hemiI: 0.62, exposure: 1.25 },
  { e: -0.08, zenith: 0x1b2850, horizon: 0x7d6b8f, glow: 0xe08a6a, sun: 0x9aaee8, sunI: 0.45, hemiSky: 0x5a6a9a, hemiGround: 0x2a2219, hemiI: 0.6, exposure: 1.2 },
  { e: 0.06, zenith: 0x3a62a8, horizon: 0xffb27a, glow: 0xff9a50, sun: 0xff9a55, sunI: 2.6, hemiSky: 0x8a9fd0, hemiGround: 0x4a3626, hemiI: 0.95, exposure: 1.08 },
  { e: 0.22, zenith: 0x3d78c2, horizon: 0xf4d2ad, glow: 0xffc888, sun: 0xffcf98, sunI: 3.1, hemiSky: 0x9ab8e6, hemiGround: 0x5a4632, hemiI: 1.25, exposure: 1.03 },
  { e: 0.55, zenith: 0x3f86d0, horizon: 0xbcd6ea, glow: 0xfff0d0, sun: 0xffe8c8, sunI: 3.3, hemiSky: 0xa9cbf2, hemiGround: 0x665638, hemiI: 1.45, exposure: 1.0 },
];

const col2 = new THREE.Color();
function mixHex(a: number, b: number, t: number, out: THREE.Color): THREE.Color {
  return out.set(a).lerp(col2.set(b), t);
}

export interface SkyState {
  /** Unit direction towards the sun. */
  sunDir: THREE.Vector3;
  /** The light that casts shadows: the sun by day, the moon by night. */
  lightDir: THREE.Vector3;
  lightColor: THREE.Color;
  lightIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  horizon: THREE.Color;
  exposure: number;
  /** 0 = day, 1 = night (lamps, windows, stars). */
  night: number;
}

/** A gradient sky dome with a sun, a moon and stars, plus the light rig for the time of day. */
export class Sky {
  readonly mesh: THREE.Mesh;
  readonly state: SkyState = {
    sunDir: new THREE.Vector3(),
    lightDir: new THREE.Vector3(),
    lightColor: new THREE.Color(),
    lightIntensity: 1,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 1,
    horizon: new THREE.Color(),
    exposure: 1,
    night: 0,
  };
  private readonly uniforms = {
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uGlow: { value: new THREE.Color() },
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    uMoon: { value: new THREE.Vector3(0, -1, 0) },
    uNight: { value: 0 },
  };

  constructor() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: this.uniforms,
      vertexShader: `varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position.z = gl_Position.w * 0.99999;
        }`,
      fragmentShader: `uniform vec3 uZenith, uHorizon, uGlow, uSun, uMoon; uniform float uNight; varying vec3 vDir;
        float hash(vec3 p) { return fract(sin(dot(p, vec3(41.3, 289.1, 117.7))) * 43758.5); }
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -0.25, 1.0);
          vec3 c = mix(uHorizon, uZenith, pow(smoothstep(-0.05, 0.72, h), 0.65));
          c = mix(c, uHorizon * 0.55, 1.0 - smoothstep(-0.25, 0.0, d.y));
          float s = max(dot(d, uSun), 0.0);
          float up = smoothstep(-0.12, 0.05, uSun.y);
          c += uGlow * (pow(s, 4.0) * 0.38 + pow(s, 60.0) * 0.7) * (0.35 + 0.65 * up);
          c += vec3(1.0, 0.96, 0.85) * smoothstep(0.9993, 0.9997, s) * 3.0 * up;
          float m = max(dot(d, uMoon), 0.0);
          c += vec3(0.85, 0.9, 1.0) * smoothstep(0.99965, 0.99985, m) * 1.4 * uNight;
          c += vec3(0.4, 0.5, 0.8) * pow(m, 40.0) * 0.25 * uNight;
          vec3 q = floor(d * 220.0);
          float st = step(0.9972, hash(q)) * smoothstep(0.02, 0.35, d.y) * uNight;
          c += vec3(st) * (0.6 + 0.4 * hash(q + 3.1));
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), mat);
    this.mesh.name = "sky";
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
  }

  /** Recompute the sky and light rig for time `t` (0..1). */
  set(t: number): SkyState {
    const st = this.state;
    // The sun rises in the east (+x), crosses the southern sky, sets in the west.
    const a = (t - 0.25) * Math.PI * 2;
    st.sunDir.set(Math.cos(a), Math.sin(a) * 0.88, 0.42).normalize();
    const e = st.sunDir.y;
    let i = 0;
    while (i < KEYS.length - 2 && e > KEYS[i + 1]!.e) i++;
    const k0 = KEYS[i]!, k1 = KEYS[i + 1]!;
    const f = THREE.MathUtils.clamp((e - k0.e) / (k1.e - k0.e), 0, 1);
    const u = this.uniforms;
    mixHex(k0.zenith, k1.zenith, f, u.uZenith.value);
    mixHex(k0.horizon, k1.horizon, f, u.uHorizon.value);
    mixHex(k0.glow, k1.glow, f, u.uGlow.value);
    st.horizon.copy(u.uHorizon.value);
    mixHex(k0.hemiSky, k1.hemiSky, f, st.hemiSky);
    mixHex(k0.hemiGround, k1.hemiGround, f, st.hemiGround);
    st.hemiIntensity = k0.hemiI + (k1.hemiI - k0.hemiI) * f;
    st.exposure = k0.exposure + (k1.exposure - k0.exposure) * f;
    st.night = THREE.MathUtils.smoothstep(-e, -0.12, 0.1);
    u.uSun.value.copy(st.sunDir);
    u.uMoon.value.copy(st.sunDir).negate();
    u.uMoon.value.y = Math.abs(u.uMoon.value.y) * 0.8 + 0.25;
    u.uMoon.value.normalize();
    u.uNight.value = st.night;
    // Shadows come from the sun while it's up, from the moon once it's down.
    const sunUp = THREE.MathUtils.smoothstep(e, -0.04, 0.06);
    if (e > -0.02) {
      st.lightDir.copy(st.sunDir);
      st.lightDir.y = Math.max(st.lightDir.y, 0.12);
      st.lightDir.normalize();
      mixHex(k0.sun, k1.sun, f, st.lightColor);
      st.lightIntensity = (k0.sunI + (k1.sunI - k0.sunI) * f) * sunUp;
    } else {
      st.lightDir.copy(u.uMoon.value);
      st.lightColor.set(0x9db4ff);
      st.lightIntensity = 0.7 * THREE.MathUtils.smoothstep(-e, 0.02, 0.15);
    }
    return st;
  }
}
