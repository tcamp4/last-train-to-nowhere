import * as THREE from 'three';
import type { GameState, QualitySettings } from '../shared/types';
import type { TrainMaterials } from './materials';
import { makeMesh, roundedBox } from './materials';

interface MovingInstance {
  mesh: THREE.InstancedMesh;
  positions: THREE.Vector3[];
  rotations: THREE.Euler[];
  scales: THREE.Vector3[];
  minZ: number;
  maxZ: number;
}

export interface WorldRig {
  root: THREE.Group;
  track: THREE.Group;
  ash: THREE.Points;
  moving: MovingInstance[];
  update(state: GameState, dt: number, elapsed: number, cameraPosition: THREE.Vector3): void;
  setQuality(settings: QualitySettings): void;
  dispose(): void;
}

class Random {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  next() {
    let x = this.state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 4294967296;
  }
  range(min: number, max: number) { return min + (max - min) * this.next(); }
}

function distortedRockGeometry() {
  const geometry = new THREE.IcosahedronGeometry(1, 2);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const warp = 0.9 + Math.sin(x * 5.1 + y * 2.3 + z * 4.2) * 0.08 + Math.cos(y * 7.3) * 0.05;
    position.setXYZ(i, x * warp, y * (0.82 + warp * 0.2), z * warp);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function withInstanceColors(mesh: THREE.InstancedMesh, count: number, rng: Random, base: THREE.Color) {
  for (let i = 0; i < count; i += 1) {
    const color = base.clone().offsetHSL(rng.range(-0.025, 0.025), rng.range(-0.04, 0.025), rng.range(-0.09, 0.08));
    mesh.setColorAt(i, color);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

function makeMovingInstances(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  count: number,
  minZ: number,
  maxZ: number,
  rng: Random,
  placement: (i: number, rng: Random) => { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
) {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const positions: THREE.Vector3[] = [];
  const rotations: THREE.Euler[] = [];
  const scales: THREE.Vector3[] = [];
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i += 1) {
    const transform = placement(i, rng);
    positions.push(transform.position);
    rotations.push(transform.rotation);
    scales.push(transform.scale);
    dummy.position.copy(transform.position);
    dummy.rotation.copy(transform.rotation);
    dummy.scale.copy(transform.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return { mesh, positions, rotations, scales, minZ, maxZ } satisfies MovingInstance;
}

function makeDeadTreeGeometry() {
  const trunk = new THREE.CylinderGeometry(0.12, 0.34, 5.8, 10, 5);
  const position = trunk.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    position.setXYZ(i, x + Math.sin(y * 1.43) * 0.18, y + 2.85, z + Math.cos(y * 1.11) * 0.12);
  }
  trunk.computeVertexNormals();
  return trunk;
}

function makePylonGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.9, 0); shape.lineTo(0.9, 0); shape.lineTo(0.3, 7.8); shape.lineTo(-0.3, 7.8); shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-0.42, 0.7); hole.lineTo(0.42, 0.7); hole.lineTo(0.17, 6.65); hole.lineTo(-0.17, 6.65); hole.closePath();
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.34, bevelEnabled: true, bevelSegments: 2, bevelSize: 0.06, bevelThickness: 0.06 });
  geometry.center();
  geometry.translate(0, 3.9, 0);
  return geometry;
}

function createGround(materials: TrainMaterials, rng: Random) {
  const group = new THREE.Group();
  const chunks: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i += 1) {
    const geometry = new THREE.PlaneGeometry(160, 70, 36, 18);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.attributes.position as THREE.BufferAttribute;
    for (let v = 0; v < position.count; v += 1) {
      const x = position.getX(v);
      const z = position.getZ(v);
      const railCut = Math.exp(-(x * x) / 70);
      const height = (Math.sin(x * 0.083 + i) * 0.65 + Math.cos(z * 0.115 - i * 0.7) * 0.43 + rng.range(-0.25, 0.25)) * (1 - railCut * 0.82);
      position.setY(v, -1.78 + height);
    }
    geometry.computeVertexNormals();
    const mesh = makeMesh(geometry, materials.ground, false, true);
    mesh.position.z = (i - 3) * 70;
    mesh.receiveShadow = true;
    group.add(mesh);
    chunks.push(mesh);
  }
  return { group, chunks };
}

function createAsh(count: number) {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const drift = new Float32Array(count);
  const rng = new Random(87523);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = rng.range(-44, 44);
    positions[i * 3 + 1] = rng.range(-1, 17);
    positions[i * 3 + 2] = rng.range(-55, 45);
    sizes[i] = rng.range(1.2, 4.5);
    drift[i] = rng.range(0.45, 1.8);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aDrift', new THREE.BufferAttribute(drift, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0.72 } },
    vertexShader: `
      attribute float aSize;
      attribute float aDrift;
      uniform float uTime;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * aDrift + p.z * .16) * 1.5;
        p.y += mod(uTime * (.7 + aDrift) + position.y + 2.0, 20.0) - position.y - 2.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * (80.0 / max(12.0, -mv.z));
        vAlpha = smoothstep(80.0, 5.0, -mv.z);
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      varying float vAlpha;
      void main() {
        vec2 q = gl_PointCoord - .5;
        float d = length(q);
        if (d > .5) discard;
        float ragged = .42 + .08 * sin(atan(q.y, q.x) * 7.0);
        float a = smoothstep(ragged, .05, d) * uOpacity * vAlpha;
        gl_FragColor = vec4(.73, .68, .58, a);
      }
    `,
  });
  return new THREE.Points(geometry, material);
}

export function createWorld(materials: TrainMaterials, quality: QualitySettings): WorldRig {
  const rng = new Random(445813);
  const root = new THREE.Group();
  root.name = 'recycled-ash-waste';
  const moving: MovingInstance[] = [];
  const ground = createGround(materials, rng);
  root.add(ground.group);

  const sleeper = makeMovingInstances(
    roundedBox(7.2, 0.22, 0.42, 0.08, 2), materials.sleeper, 140, -220, 90, rng,
    (i) => ({ position: new THREE.Vector3(0, -1.24, -215 + i * 2.2), rotation: new THREE.Euler(0, rng.range(-0.02, 0.02), 0), scale: new THREE.Vector3(rng.range(0.96, 1.04), 1, 1) }),
  );
  moving.push(sleeper); root.add(sleeper.mesh);
  withInstanceColors(sleeper.mesh, 140, rng, new THREE.Color('#372f28'));
  for (const x of [-2.98, 2.98]) {
    const rail = makeMovingInstances(
      roundedBox(0.15, 0.2, 6.4, 0.035, 2), materials.rail, 54, -220, 100, rng,
      (i) => ({ position: new THREE.Vector3(x, -1.0, -216 + i * 6.2), rotation: new THREE.Euler(0, 0, 0), scale: new THREE.Vector3(1, 1, 1) }),
    );
    moving.push(rail); root.add(rail.mesh);
  }
  const rocks = makeMovingInstances(
    distortedRockGeometry(), materials.ground, 92, -230, 100, rng,
    () => {
      const side = rng.next() > 0.5 ? 1 : -1;
      const distance = rng.range(10, 74);
      const scale = rng.range(0.45, 3.4);
      return {
        position: new THREE.Vector3(side * distance, rng.range(-1.3, 0.1), rng.range(-230, 100)),
        rotation: new THREE.Euler(rng.range(-0.3, 0.3), rng.range(0, Math.PI * 2), rng.range(-0.2, 0.2)),
        scale: new THREE.Vector3(scale * rng.range(0.7, 1.5), scale * rng.range(0.5, 1.8), scale),
      };
    },
  );
  moving.push(rocks); root.add(rocks.mesh);
  withInstanceColors(rocks.mesh, 92, rng, new THREE.Color('#51493c'));
  const trees = makeMovingInstances(
    makeDeadTreeGeometry(), materials.sleeper, 44, -230, 100, rng,
    () => ({
      position: new THREE.Vector3((rng.next() > 0.5 ? 1 : -1) * rng.range(15, 66), rng.range(-1.8, -0.9), rng.range(-230, 100)),
      rotation: new THREE.Euler(rng.range(-0.08, 0.08), rng.range(0, Math.PI * 2), rng.range(-0.16, 0.16)),
      scale: new THREE.Vector3(rng.range(0.65, 1.55), rng.range(0.8, 2.15), rng.range(0.65, 1.55)),
    }),
  );
  moving.push(trees); root.add(trees.mesh);
  const pylons = makeMovingInstances(
    makePylonGeometry(), materials.darkSteel, 16, -240, 100, rng,
    (i) => ({
      position: new THREE.Vector3((i % 2 ? 1 : -1) * rng.range(17, 27), -1.5, -230 + i * 21 + rng.range(-2, 2)),
      rotation: new THREE.Euler(0, rng.range(-0.12, 0.12), rng.range(-0.06, 0.06)),
      scale: new THREE.Vector3(rng.range(0.8, 1.15), rng.range(0.75, 1.4), 1),
    }),
  );
  moving.push(pylons); root.add(pylons.mesh);

  // Distant industrial graveyard silhouettes create large-scale landmarks without dominating draw calls.
  const landmarkMaterial = materials.darkSteel.clone();
  landmarkMaterial.color.set('#252a29');
  landmarkMaterial.roughness = 0.84;
  const landmarkGeometry = new THREE.CylinderGeometry(2.6, 5.6, 12, 32, 8, true);
  const landmark = makeMovingInstances(
    landmarkGeometry, landmarkMaterial, 11, -260, 110, rng,
    (i) => {
      const side = i % 2 ? 1 : -1;
      const tall = i % 4 === 0 ? 2.2 : rng.range(0.7, 1.35);
      return {
        position: new THREE.Vector3(side * rng.range(48, 82), 3.2 * tall, -240 + i * 31 + rng.range(-9, 9)),
        rotation: new THREE.Euler(rng.range(-0.12, 0.12), rng.range(0, Math.PI), rng.range(-0.06, 0.06)),
        scale: new THREE.Vector3(rng.range(0.75, 1.8), tall, rng.range(0.75, 1.8)),
      };
    },
  );
  moving.push(landmark); root.add(landmark.mesh);

  const track = new THREE.Group();
  track.name = 'moving-track';
  root.add(track);
  const ash = createAsh(Math.max(1400, quality.particles));
  root.add(ash);
  const dummy = new THREE.Object3D();

  function updateInstances(item: MovingInstance, travel: number) {
    const span = item.maxZ - item.minZ;
    for (let i = 0; i < item.positions.length; i += 1) {
      const pos = item.positions[i];
      pos.z += travel;
      if (pos.z > item.maxZ) pos.z -= span;
      dummy.position.copy(pos);
      dummy.rotation.copy(item.rotations[i]);
      dummy.scale.copy(item.scales[i]);
      dummy.updateMatrix();
      item.mesh.setMatrixAt(i, dummy.matrix);
    }
    item.mesh.instanceMatrix.needsUpdate = true;
  }

  return {
    root, track, ash, moving,
    update(state, dt, elapsed, cameraPosition) {
      const travel = Math.max(0, state.speed) * dt;
      moving.forEach((item) => updateInstances(item, travel));
      ground.chunks.forEach((chunk) => {
        chunk.position.z += travel;
        if (chunk.position.z > 105) chunk.position.z -= 420;
      });
      ash.position.set(cameraPosition.x, 0, cameraPosition.z);
      const shader = ash.material as THREE.ShaderMaterial;
      shader.uniforms.uTime.value = elapsed;
      shader.uniforms.uOpacity.value = 0.38 + state.threatLevel * 0.035;
      root.rotation.z = Math.sin(elapsed * 0.12) * 0.002;
    },
    setQuality(settings) {
      const drawCount = Math.min(ash.geometry.getAttribute('position').count, settings.particles);
      ash.geometry.setDrawRange(0, drawCount);
      rocks.mesh.castShadow = settings.shadows;
      trees.mesh.castShadow = settings.shadows;
      pylons.mesh.castShadow = settings.shadows;
    },
    dispose() {
      const disposed = new Set<THREE.BufferGeometry | THREE.Material>();
      root.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.InstancedMesh) {
          if (!disposed.has(object.geometry)) { object.geometry.dispose(); disposed.add(object.geometry); }
          const materialList = Array.isArray(object.material) ? object.material : [object.material];
          materialList.forEach((material) => {
            // Shared train materials are disposed by their owner; only dispose local clones/shaders.
            if ((material === landmarkMaterial || material === ash.material) && !disposed.has(material)) { material.dispose(); disposed.add(material); }
          });
        }
      });
    },
  };
}
