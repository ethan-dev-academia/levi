import * as THREE from "three";
import { getTerrainHeight, type Heightmap } from "@levi/shared";
import { placeOnGround } from "./terrainAlign.js";

const camRight = new THREE.Vector3();

/**
 * A 2D pixel sprite standing on 3D terrain: camera-facing THREE.Sprite with
 * its anchor at the feet, plus a blob shadow decal aligned to the slope.
 */
export class BillboardEntity {
  readonly root = new THREE.Group();
  private readonly sprite: THREE.Sprite;
  private readonly shadow: THREE.Mesh;
  private readonly baseScaleX: number;
  private walkPhase = 0;

  constructor(texture: THREE.Texture, worldHeight: number, aspect: number) {
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, alphaTest: 0.5 });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.center.set(0.5, 0); // pivot at feet
    this.baseScaleX = worldHeight * aspect;
    this.sprite.scale.set(this.baseScaleX, worldHeight, 1);

    const shadowGeom = new THREE.CircleGeometry(worldHeight * 0.22, 16);
    shadowGeom.rotateX(-Math.PI / 2);
    shadowGeom.scale(1.3, 1, 0.8);
    this.shadow = new THREE.Mesh(
      shadowGeom,
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false }),
    );

    this.root.add(this.sprite);
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.root, this.shadow);
  }

  /**
   * Snap to terrain at gameplay (x, z). `dirX/dirZ` is the movement direction;
   * the sprite flips to face left/right relative to the camera.
   */
  update(hm: Heightmap, x: number, z: number, moving: boolean, dirX: number, dirZ: number, camera: THREE.Camera, dt: number): void {
    this.root.position.set(x, getTerrainHeight(hm, x, z), z);
    placeOnGround(this.shadow, hm, x, z);

    camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    const side = dirX * camRight.x + dirZ * camRight.z;
    if (Math.abs(side) > 0.05) this.sprite.scale.x = side < 0 ? -this.baseScaleX : this.baseScaleX;

    // Simple walk bob until the animation system lands.
    this.walkPhase = moving ? this.walkPhase + dt * 14 : 0;
    this.sprite.position.y = moving ? Math.abs(Math.sin(this.walkPhase)) * 0.08 : 0;
  }
}
