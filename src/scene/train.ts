import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameState, SystemId } from '../shared/types';
import type { TrainMaterials } from './materials';
import { makeMesh, roundedBox } from './materials';

interface PoweredRig {
  id: SystemId;
  objects: THREE.Object3D[];
  emissive: THREE.MeshStandardMaterial[];
}

export interface TrainRig {
  root: THREE.Group;
  carBodies: THREE.Group[];
  wheels: THREE.Group[];
  bogies: THREE.Group[];
  doors: THREE.Group[];
  fans: THREE.Object3D[];
  hanging: THREE.Object3D[];
  powered: PoweredRig[];
  alarmMaterials: THREE.MeshStandardMaterial[];
  turret: THREE.Group;
  muzzle: THREE.Object3D;
  cameraCollision: THREE.Group;
  upgradeVariants: Map<string, THREE.Group>;
  update(state: GameState, elapsed: number, dt: number): void;
  dispose(): void;
}

const CAR_LENGTH = 17;
export const CAR_CENTERS = [-27, -9, 9, 27] as const;
export const TRAIN_HALF_WIDTH = 3.48;
export const TRAIN_FLOOR_Y = 0;

function add(parent: THREE.Object3D, mesh: THREE.Object3D, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  parent.add(mesh);
  return mesh;
}

function isWithin(object: THREE.Object3D, root: THREE.Object3D) {
  let cursor: THREE.Object3D | null = object;
  while (cursor) {
    if (cursor === root) return true;
    cursor = cursor.parent;
  }
  return false;
}

/**
 * The train kit is authored from original procedural surfaces at runtime. Static
 * fittings are collapsed by material after authoring, preserving the modeled
 * silhouette while turning hundreds of individual rivets/panels into ~one draw
 * per material and car.
 */
function mergeStaticByMaterial(root: THREE.Group, dynamicRoots: Set<THREE.Object3D> = new Set()) {
  root.updateWorldMatrix(true, true);
  const inverseRoot = root.matrixWorld.clone().invert();
  const buckets = new Map<THREE.Material, { geometries: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>();
  const sourceGeometries = new Set<THREE.BufferGeometry>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
    if ([...dynamicRoots].some((dynamic) => isWithin(object, dynamic))) return;
    const relative = inverseRoot.clone().multiply(object.matrixWorld);
    const geometry = (object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone()).applyMatrix4(relative);
    const bucket = buckets.get(object.material) ?? { geometries: [], meshes: [] };
    bucket.geometries.push(geometry);
    bucket.meshes.push(object);
    buckets.set(object.material, bucket);
    sourceGeometries.add(object.geometry);
  });
  for (const [material, bucket] of buckets) {
    const merged = mergeGeometries(bucket.geometries, false);
    bucket.geometries.forEach((geometry) => geometry.dispose());
    if (!merged) continue;
    const mesh = makeMesh(merged, material);
    mesh.name = `merged-${material.name || material.type}`;
    root.add(mesh);
    bucket.meshes.forEach((source) => source.removeFromParent());
  }
  sourceGeometries.forEach((geometry) => geometry.dispose());
}

function createInstancedFromAnchors(anchors: THREE.Group[], parent: THREE.Group, name: string) {
  const prototype = anchors[0];
  prototype.updateWorldMatrix(true, true);
  const inversePrototype = prototype.matrixWorld.clone().invert();
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  prototype.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
    const relative = inversePrototype.clone().multiply(object.matrixWorld);
    const list = buckets.get(object.material) ?? [];
    list.push((object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone()).applyMatrix4(relative));
    buckets.set(object.material, list);
  });
  const materialGeometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  for (const [material, geometries] of buckets) {
    const merged = mergeGeometries(geometries, false);
    geometries.forEach((geometry) => geometry.dispose());
    if (!merged) continue;
    materialGeometries.push(merged);
    materials.push(material);
  }
  const geometry = mergeGeometries(materialGeometries, true);
  materialGeometries.forEach((entry) => entry.dispose());
  if (!geometry) throw new Error(`Unable to instance ${name}`);
  const sourceGeometries = new Set<THREE.BufferGeometry>();
  for (const anchor of anchors) {
    const meshes: THREE.Mesh[] = [];
    anchor.traverse((object) => { if (object instanceof THREE.Mesh) meshes.push(object); });
    meshes.forEach((mesh) => { sourceGeometries.add(mesh.geometry); mesh.removeFromParent(); });
  }
  sourceGeometries.forEach((entry) => entry.dispose());
  const instances = new THREE.InstancedMesh(geometry, materials, anchors.length);
  instances.name = name;
  instances.castShadow = true;
  instances.receiveShadow = true;
  instances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  parent.add(instances);
  return instances;
}

function updateInstances(mesh: THREE.InstancedMesh, anchors: THREE.Group[], root: THREE.Group, dummy: THREE.Object3D) {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert();
  anchors.forEach((anchor, index) => {
    dummy.matrix.copy(inverse).multiply(anchor.matrixWorld);
    mesh.setMatrixAt(index, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
}

function cylinder(radius: number, length: number, material: THREE.Material, radialSegments = 20) {
  return makeMesh(new THREE.CylinderGeometry(radius, radius, length, radialSegments, 2), material);
}

function pipe(parent: THREE.Object3D, material: THREE.Material, points: THREE.Vector3[], radius = 0.055) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.08);
  const mesh = makeMesh(new THREE.TubeGeometry(curve, Math.max(12, points.length * 8), radius, 7, false), material);
  parent.add(mesh);
  return mesh;
}

function makeGauge(materials: TrainMaterials, radius = 0.19) {
  const gauge = new THREE.Group();
  const rim = makeMesh(new THREE.TorusGeometry(radius, 0.035, 8, 24), materials.brass);
  const face = makeMesh(new THREE.CircleGeometry(radius - 0.025, 24), materials.screen, false, false);
  face.position.z = 0.015;
  const needle = makeMesh(roundedBox(0.018, radius * 0.82, 0.014, 0.005, 2), materials.warning, false, false);
  needle.position.set(0, radius * 0.23, 0.034);
  needle.rotation.z = 0.7;
  gauge.add(rim, face, needle);
  return gauge;
}

function makeValve(materials: TrainMaterials, radius = 0.28) {
  const group = new THREE.Group();
  group.add(makeMesh(new THREE.TorusGeometry(radius, 0.035, 8, 22), materials.warning));
  for (let i = 0; i < 3; i += 1) {
    const spoke = makeMesh(roundedBox(radius * 1.72, 0.045, 0.045, 0.014, 2), materials.warning);
    spoke.rotation.z = i * Math.PI / 3;
    group.add(spoke);
  }
  group.add(makeMesh(new THREE.CylinderGeometry(0.07, 0.07, 0.13, 12), materials.brass).rotateX(Math.PI / 2));
  return group;
}

function makeWindow(materials: TrainMaterials) {
  const group = new THREE.Group();
  group.add(makeMesh(roundedBox(1.42, 1.42, 0.13, 0.16, 4), materials.brass));
  const glass = makeMesh(roundedBox(1.15, 1.16, 0.08, 0.14, 4), materials.glass, false, true);
  glass.position.z = 0.06;
  group.add(glass);
  for (let i = -1; i <= 1; i += 2) {
    const bolt = makeMesh(new THREE.CylinderGeometry(0.032, 0.032, 0.035, 10), materials.darkSteel);
    bolt.rotation.x = Math.PI / 2;
    bolt.position.set(i * 0.61, 0.61, 0.105);
    group.add(bolt);
    const bolt2 = bolt.clone();
    bolt2.position.y = -0.61;
    group.add(bolt2);
  }
  return group;
}

function makeWallLamp(materials: TrainMaterials, lampMaterial: THREE.MeshStandardMaterial) {
  const group = new THREE.Group();
  group.add(makeMesh(new THREE.CylinderGeometry(0.18, 0.22, 0.14, 18), materials.brass));
  const globe = makeMesh(new THREE.SphereGeometry(0.16, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.64), lampMaterial);
  globe.position.y = 0.11;
  group.add(globe);
  return group;
}

function buildShell(materials: TrainMaterials, index: number, z: number, lampMaterial: THREE.MeshStandardMaterial) {
  const car = new THREE.Group();
  car.name = `car-${index}`;
  car.position.z = z;

  add(car, makeMesh(roundedBox(7.25, 0.38, CAR_LENGTH, 0.16, 3), materials.darkSteel), 0, -0.22, 0);
  add(car, makeMesh(roundedBox(6.7, 0.14, CAR_LENGTH - 0.5, 0.06, 2), materials.steel), 0, 0.06, 0);
  // Layered side structure preserves sightlines while reading as substantial armored construction.
  for (const side of [-1, 1]) {
    add(car, makeMesh(roundedBox(0.28, 1.25, CAR_LENGTH, 0.09, 3), materials.armor), side * 3.42, 0.66, 0);
    add(car, makeMesh(roundedBox(0.24, 0.82, CAR_LENGTH, 0.09, 3), materials.armor), side * 3.43, 3.68, 0);
    add(car, makeMesh(roundedBox(0.18, 0.18, CAR_LENGTH - 0.4, 0.05, 2), materials.brass), side * 3.58, 1.39, 0);
    add(car, makeMesh(roundedBox(0.2, 0.17, CAR_LENGTH - 0.4, 0.05, 2), materials.brass), side * 3.59, 3.2, 0);
    for (let wz = -6.2; wz <= 6.2; wz += 3.1) {
      const window = makeWindow(materials);
      window.rotation.y = side * Math.PI / 2;
      window.position.set(side * 3.48, 2.26, wz);
      car.add(window);
    }
  }
  add(car, makeMesh(roundedBox(6.92, 0.33, CAR_LENGTH, 0.14, 3), materials.armor), 0, 4.23, 0);
  for (let ribZ = -7.9; ribZ < 8.2; ribZ += 2.1) {
    const arch = new THREE.Group();
    add(arch, makeMesh(roundedBox(0.12, 4.2, 0.14, 0.04, 2), materials.brass), -3.22, 2.04, 0);
    add(arch, makeMesh(roundedBox(0.12, 4.2, 0.14, 0.04, 2), materials.brass), 3.22, 2.04, 0);
    add(arch, makeMesh(roundedBox(6.56, 0.12, 0.14, 0.04, 2), materials.brass), 0, 4.04, 0);
    arch.position.z = ribZ;
    car.add(arch);
  }
  for (const lz of [-5.9, -2, 2, 5.9]) {
    const lamp = makeWallLamp(materials, lampMaterial);
    lamp.position.set(0, 3.94, lz);
    lamp.rotation.z = Math.PI;
    car.add(lamp);
  }
  // Layered external armor, rivets, steps, and underframe.
  for (const side of [-1, 1]) {
    for (const az of [-5.8, -2.9, 0, 2.9, 5.8]) {
      const plate = makeMesh(roundedBox(0.12, 0.95, 2.45, 0.09, 3), materials.armor);
      plate.position.set(side * 3.64, 0.71, az);
      plate.rotation.y = side * 0.015;
      car.add(plate);
      for (const rz of [-0.93, 0.93]) {
        const rivet = makeMesh(new THREE.SphereGeometry(0.055, 10, 7), materials.brass);
        rivet.position.set(side * 3.72, 1.05, az + rz);
        car.add(rivet);
      }
    }
  }
  add(car, makeMesh(roundedBox(4.7, 0.35, CAR_LENGTH - 1, 0.12, 3), materials.darkSteel), 0, -0.65, 0);
  return car;
}

function makeWheelAssembly(materials: TrainMaterials, z: number) {
  const bogie = new THREE.Group();
  bogie.position.set(0, -1.15, z);
  add(bogie, makeMesh(roundedBox(5.8, 0.42, 3.35, 0.12, 3), materials.darkSteel), 0, 0.22, 0);
  const wheels: THREE.Group[] = [];
  for (const x of [-3.0, 3.0]) {
    for (const dz of [-1.08, 1.08]) {
      const wheel = new THREE.Group();
      const tire = makeMesh(new THREE.CylinderGeometry(0.69, 0.69, 0.25, 28, 2), materials.darkSteel);
      tire.rotation.z = Math.PI / 2;
      wheel.add(tire);
      const flange = makeMesh(new THREE.TorusGeometry(0.53, 0.075, 8, 28), materials.steel);
      flange.rotation.y = Math.PI / 2;
      flange.position.x = Math.sign(x) * 0.145;
      wheel.add(flange);
      for (let s = 0; s < 6; s += 1) {
        const spoke = makeMesh(roundedBox(0.08, 0.8, 0.06, 0.025, 2), materials.brass);
        spoke.rotation.x = Math.PI / 2;
        spoke.rotation.z = (s / 6) * Math.PI;
        spoke.position.x = Math.sign(x) * 0.16;
        wheel.add(spoke);
      }
      wheel.position.set(x, -0.18, dz);
      bogie.add(wheel);
      wheels.push(wheel);
    }
  }
  for (const x of [-2.1, 2.1]) {
    const spring = makeMesh(new THREE.TorusKnotGeometry(0.14, 0.035, 40, 6, 2, 9), materials.brass);
    spring.scale.set(1, 1.5, 1);
    spring.position.set(x, 0.58, 0);
    bogie.add(spring);
  }
  return { bogie, wheels };
}

function makeDoor(materials: TrainMaterials, z: number) {
  const rig = new THREE.Group();
  rig.position.z = z;
  const left = makeMesh(roundedBox(2.1, 3.55, 0.23, 0.18, 4), materials.armor);
  const right = left.clone();
  left.position.x = -1.08;
  right.position.x = 1.08;
  rig.add(left, right);
  for (const panel of [left, right]) {
    const slit = makeMesh(roundedBox(0.7, 1.26, 0.07, 0.12, 3), materials.glass);
    slit.position.set(0, 0.55, 0.16 * Math.sign(z || 1));
    panel.add(slit);
    const brace = makeMesh(roundedBox(1.52, 0.11, 0.08, 0.04, 2), materials.brass);
    brace.position.z = 0.17 * Math.sign(z || 1);
    brace.rotation.z = panel === left ? 0.55 : -0.55;
    panel.add(brace);
  }
  return rig;
}

function controlInterior(car: THREE.Group, materials: TrainMaterials, powered: PoweredRig[], fans: THREE.Object3D[], turret: THREE.Group) {
  const consoleGroup = new THREE.Group();
  add(consoleGroup, makeMesh(roundedBox(5.5, 1.42, 1.5, 0.25, 4), materials.darkSteel), 0, 0.78, -7);
  const consoleTop = makeMesh(roundedBox(5.12, 0.13, 1.15, 0.08, 3), materials.brass);
  consoleTop.rotation.x = -0.27;
  add(consoleGroup, consoleTop, 0, 1.52, -6.88);
  const screens: THREE.MeshStandardMaterial[] = [];
  for (let i = -2; i <= 2; i += 1) {
    const gauge = makeGauge(materials, i === 0 ? 0.26 : 0.2);
    gauge.rotation.x = -0.27;
    gauge.position.set(i * 0.86, 1.58, -6.75);
    consoleGroup.add(gauge);
    screens.push(materials.screen);
  }
  const leverBase = cylinder(0.14, 0.28, materials.brass, 14);
  leverBase.position.set(-1.85, 1.75, -6.42);
  consoleGroup.add(leverBase);
  const throttle = cylinder(0.055, 0.85, materials.steel, 10);
  throttle.rotation.x = 0.65;
  throttle.position.set(-1.85, 2.1, -6.18);
  consoleGroup.add(throttle);
  const handle = makeMesh(new THREE.SphereGeometry(0.15, 16, 10), materials.warning);
  handle.position.set(-1.85, 2.39, -5.94);
  consoleGroup.add(handle);
  car.add(consoleGroup);

  const scanner = new THREE.Group();
  add(scanner, makeMesh(roundedBox(1.8, 1.75, 0.34, 0.2, 4), materials.darkSteel), 2.1, 2.47, -7.64);
  const radarFace = makeMesh(new THREE.CircleGeometry(0.63, 32), materials.screen, false, false);
  radarFace.position.set(2.1, 2.5, -7.43);
  scanner.add(radarFace);
  const sweep = makeMesh(roundedBox(0.035, 0.62, 0.03, 0.012, 2), materials.lamp, false, false);
  sweep.position.set(2.1, 2.78, -7.39);
  scanner.add(sweep);
  car.add(scanner);
  fans.push(sweep);
  powered.push({ id: 'radar', objects: [scanner], emissive: [materials.screen] });

  const gun = turret;
  gun.position.set(0, 4.75, -5.75);
  car.add(gun);
  powered.push({ id: 'turret', objects: [gun], emissive: [] });

  for (const x of [-2.05, 2.05]) {
    const chair = new THREE.Group();
    add(chair, makeMesh(roundedBox(1.05, 0.3, 1.15, 0.17, 4), materials.leather), 0, 0.82, 0);
    add(chair, makeMesh(roundedBox(1.05, 1.3, 0.27, 0.17, 4), materials.leather), 0, 1.42, 0.48, -0.14);
    add(chair, cylinder(0.1, 0.75, materials.brass, 12), 0, 0.38, 0);
    chair.position.set(x, 0, -4.75);
    car.add(chair);
  }
}

function engineeringInterior(car: THREE.Group, materials: TrainMaterials, powered: PoweredRig[], fans: THREE.Object3D[]) {
  const generator = new THREE.Group();
  // This is the generator's outer casing, not a free-spinning rotor. Keeping it
  // compact against the port wall preserves the aisle and prevents the casing
  // from reading as a tumbling obstacle in the third-person camera.
  const drum = cylinder(0.96, 4.05, materials.darkSteel, 32);
  drum.rotation.x = Math.PI / 2;
  generator.add(drum);
  for (const x of [-1.62, -0.81, 0, 0.81, 1.62]) {
    const band = makeMesh(new THREE.TorusGeometry(0.98, 0.065, 10, 30), materials.brass);
    band.rotation.x = Math.PI / 2;
    band.position.z = x;
    generator.add(band);
  }
  for (const x of [-0.94, 0.94]) {
    const coil = makeMesh(new THREE.TorusKnotGeometry(0.3, 0.052, 70, 8, 2, 11), materials.copper);
    coil.rotation.x = Math.PI / 2;
    coil.position.z = x;
    generator.add(coil);
  }
  generator.position.set(-2.36, 1.18, -0.6);
  car.add(generator);
  powered.push({ id: 'engine', objects: [generator], emissive: [] });
  pipe(car, materials.copper, [new THREE.Vector3(-2.65, 0.4, -6.5), new THREE.Vector3(-2.65, 3.4, -4), new THREE.Vector3(-2.65, 3.4, 4.7), new THREE.Vector3(-1.4, 2.2, 5.6)], 0.085);
  pipe(car, materials.brass, [new THREE.Vector3(2.7, 0.5, -6.7), new THREE.Vector3(2.7, 3.65, -5), new THREE.Vector3(2.7, 3.65, 4), new THREE.Vector3(1.4, 1.8, 5.8)], 0.09);

  const batteries: THREE.Object3D[] = [];
  for (let z = -6; z <= 6; z += 2) {
    for (const side of [-1, 1]) {
      const bank = new THREE.Group();
      add(bank, makeMesh(roundedBox(1.08, 1.45, 1.42, 0.17, 4), materials.armor), side * 2.45, 0.85, z);
      const cells = [];
      for (let c = -1; c <= 1; c += 1) {
        const cap = cylinder(0.12, 0.21, c === 0 ? materials.warning : materials.brass, 14);
        cap.position.set(side * 2.45 + c * 0.28, 1.65, z);
        bank.add(cap);
        cells.push(cap);
      }
      car.add(bank);
      batteries.push(bank);
    }
  }
  powered.push({ id: 'cooling', objects: batteries, emissive: [] });
  for (const z of [-5.2, 4.8]) {
    const valve = makeValve(materials, 0.36);
    valve.rotation.y = Math.PI / 2;
    valve.position.set(-3.05, 2.2, z);
    car.add(valve);
  }
  for (const z of [-4.6, 4.2]) {
    const fan = new THREE.Group();
    const rim = makeMesh(new THREE.TorusGeometry(0.52, 0.08, 8, 24), materials.brass);
    fan.add(rim);
    for (let i = 0; i < 6; i += 1) {
      const blade = makeMesh(roundedBox(0.15, 0.52, 0.045, 0.06, 3), materials.steel);
      blade.position.y = 0.24;
      blade.rotation.z = i * Math.PI / 3 + 0.35;
      fan.add(blade);
    }
    fan.position.set(3.25, 2.45, z);
    fan.rotation.y = -Math.PI / 2;
    car.add(fan);
    fans.push(fan);
  }
}

function passengerInterior(car: THREE.Group, materials: TrainMaterials, powered: PoweredRig[]) {
  for (const side of [-1, 1]) {
    for (const z of [-5.8, -2.6, 0.6, 3.8]) {
      const seat = new THREE.Group();
      add(seat, makeMesh(roundedBox(1.24, 0.33, 1.35, 0.18, 4), materials.leather), 0, 0.66, 0);
      add(seat, makeMesh(roundedBox(1.24, 1.38, 0.3, 0.18, 4), materials.leather), 0, 1.38, side * 0.51, side * -0.12);
      const rail = makeMesh(new THREE.TorusGeometry(0.36, 0.045, 8, 20, Math.PI), materials.brass);
      rail.rotation.set(0, side * Math.PI / 2, Math.PI / 2);
      rail.position.set(0, 1.66, side * 0.56);
      seat.add(rail);
      seat.position.set(side * 2.2, 0, z);
      car.add(seat);
    }
  }
  const radio = new THREE.Group();
  add(radio, makeMesh(roundedBox(2.15, 1.58, 0.72, 0.22, 4), materials.darkSteel), -2.15, 1.15, 6.65);
  const dial = makeGauge(materials, 0.25);
  dial.position.set(-2.15, 1.35, 6.25);
  dial.rotation.y = Math.PI;
  radio.add(dial);
  for (let x = -2.7; x <= -1.6; x += 0.27) {
    add(radio, makeMesh(roundedBox(0.05, 0.4, 0.035, 0.015, 2), materials.brass), x, 0.82, 6.26);
  }
  car.add(radio);
  powered.push({ id: 'medical', objects: [radio], emissive: [materials.screen] });

  const medical = new THREE.Group();
  add(medical, makeMesh(roundedBox(2.15, 0.42, 3.4, 0.2, 4), materials.steel), 2.1, 0.8, 5.15);
  add(medical, makeMesh(roundedBox(1.65, 0.32, 0.18, 0.12, 3), materials.warning), 2.1, 2.22, 6.64);
  add(medical, makeMesh(roundedBox(0.18, 1.65, 0.19, 0.09, 3), materials.warning), 2.1, 2.22, 6.63);
  car.add(medical);
}

function defenseInterior(car: THREE.Group, materials: TrainMaterials, powered: PoweredRig[], turret: THREE.Group) {
  for (const side of [-1, 1]) {
    const rack = new THREE.Group();
    for (let level = 0; level < 3; level += 1) {
      add(rack, makeMesh(roundedBox(1.15, 0.13, 6.8, 0.05, 2), materials.brass), side * 2.58, 0.55 + level * 1.25, 0);
      for (const z of [-2.8, 0, 2.8]) {
        const shell = cylinder(0.16, 0.92, level === 1 ? materials.copper : materials.steel, 16);
        shell.rotation.x = Math.PI / 2;
        shell.position.set(side * 2.58, 0.92 + level * 1.25, z);
        rack.add(shell);
      }
    }
    car.add(rack);
  }
  turret.position.set(0, 4.72, 4.7);
  // The authored barrels point along local -Z; PI is the authoritative rear/+Z rest.
  turret.rotation.y = Math.PI;
  car.add(turret);
  powered.push({ id: 'turret', objects: [turret], emissive: [] });
  const crane = new THREE.Group();
  const mast = cylinder(0.18, 3.2, materials.brass, 16);
  mast.position.y = 1.6;
  crane.add(mast);
  add(crane, makeMesh(roundedBox(0.3, 0.32, 4.8, 0.11, 3), materials.steel), 0, 3.12, -1.6, 0.08);
  const cable = cylinder(0.026, 2.35, materials.darkSteel, 8);
  cable.position.set(0, 2.05, -3.82);
  crane.add(cable);
  const hook = makeMesh(new THREE.TorusGeometry(0.22, 0.045, 8, 18, Math.PI * 1.5), materials.warning);
  hook.position.set(0, 0.87, -3.82);
  crane.add(hook);
  crane.position.set(-2.65, 0, 5.2);
  car.add(crane);
}

function createTurret(materials: TrainMaterials) {
  const turret = new THREE.Group();
  const base = cylinder(0.95, 0.36, materials.darkSteel, 28);
  turret.add(base);
  const housing = makeMesh(roundedBox(1.68, 0.86, 1.45, 0.3, 5), materials.armor);
  housing.position.y = 0.56;
  turret.add(housing);
  for (const x of [-0.34, 0.34]) {
    const barrel = cylinder(0.09, 3.4, materials.darkSteel, 16);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(x, 0.7, -2.1);
    turret.add(barrel);
    for (let z = -0.6; z > -3.1; z -= 0.48) {
      const ring = makeMesh(new THREE.TorusGeometry(0.105, 0.025, 6, 14), materials.brass);
      ring.position.set(x, 0.7, z);
      turret.add(ring);
    }
  }
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.7, -3.85);
  turret.add(muzzle);
  return { turret, muzzle };
}

function createUpgradeVariants(materials: TrainMaterials) {
  const variants = new Map<string, THREE.Group>();
  const register = (id: string, group: THREE.Group) => {
    group.name = `installed-upgrade-${id}`;
    group.visible = false;
    mergeStaticByMaterial(group);
    variants.set(id, group);
    return group;
  };

  const coils = new THREE.Group();
  for (const x of [-2.7, -2.25, -1.8]) {
    const winding = makeMesh(new THREE.TorusKnotGeometry(0.24, 0.045, 72, 8, 2, 13), materials.copper);
    winding.rotation.x = Math.PI / 2;
    winding.position.set(x, 2.45, -9.7);
    coils.add(winding);
    const crown = makeMesh(new THREE.TorusGeometry(0.3, 0.038, 8, 24), materials.brass);
    crown.rotation.x = Math.PI / 2;
    crown.position.set(x, 2.45, -9.7);
    coils.add(crown);
  }
  register('generator-coils', coils);

  const battery = new THREE.Group();
  for (let z = -14.4; z <= -11.4; z += 1.5) {
    const cell = makeMesh(roundedBox(0.82, 1.15, 1.12, 0.16, 4), materials.armor);
    cell.position.set(2.75, 1.0, z);
    battery.add(cell);
    const terminal = cylinder(0.1, 0.18, materials.copper, 14);
    terminal.position.set(2.75, 1.66, z);
    battery.add(terminal);
  }
  pipe(battery, materials.copper, [new THREE.Vector3(2.75, 1.72, -14.4), new THREE.Vector3(2.75, 1.95, -12.9), new THREE.Vector3(2.75, 1.72, -11.4)], 0.045);
  register('battery-bank', battery);

  const doors = new THREE.Group();
  for (const z of [-18, 0, 18]) {
    for (const x of [-1.15, 1.15]) {
      const plate = makeMesh(roundedBox(0.7, 2.7, 0.12, 0.12, 4), materials.darkSteel);
      plate.position.set(x, 1.84, z + 0.2);
      doors.add(plate);
      for (const y of [0.85, 1.85, 2.85]) {
        const bolt = makeMesh(new THREE.CylinderGeometry(0.055, 0.055, 0.08, 10), materials.brass);
        bolt.rotation.x = Math.PI / 2;
        bolt.position.set(x, y, z + 0.29);
        doors.add(bolt);
      }
    }
  }
  register('reinforced-doors', doors);

  const servos = new THREE.Group();
  for (const x of [-0.72, 0.72]) {
    const actuator = cylinder(0.2, 1.2, materials.brass, 18);
    actuator.rotation.z = Math.PI / 2;
    actuator.position.set(x, 5.0, 31.5);
    servos.add(actuator);
    const cable = makeMesh(new THREE.TorusGeometry(0.35, 0.045, 8, 22, Math.PI * 1.5), materials.copper);
    cable.position.set(x, 5.15, 31.5);
    servos.add(cable);
  }
  register('turret-servos', servos);

  const bunks = new THREE.Group();
  for (const y of [0.72, 1.88]) {
    const bunk = makeMesh(roundedBox(1.45, 0.24, 3.4, 0.12, 4), materials.leather);
    bunk.position.set(-2.15, y, 13.8);
    bunks.add(bunk);
    for (const z of [12.35, 15.25]) {
      const support = cylinder(0.055, 2.5, materials.brass, 10);
      support.position.set(-2.75, 1.25, z);
      bunks.add(support);
    }
  }
  register('medical-bunks', bunks);

  const repair = new THREE.Group();
  const rail = makeMesh(roundedBox(0.18, 0.18, 5.4, 0.06, 3), materials.brass);
  rail.position.set(2.82, 3.28, 24.5);
  repair.add(rail);
  const carriage = makeMesh(roundedBox(0.72, 0.5, 0.6, 0.14, 4), materials.armor);
  carriage.position.set(2.82, 3.05, 24.5);
  repair.add(carriage);
  const tool = cylinder(0.11, 1.65, materials.copper, 16);
  tool.position.set(2.82, 2.05, 24.5);
  repair.add(tool);
  register('repair-rig', repair);
  return variants;
}

function createCameraCollisionHull() {
  const group = new THREE.Group();
  group.name = 'camera-closed-hull';
  group.layers.set(2);
  const material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  material.name = 'camera-collision-only';
  for (const center of CAR_CENTERS) {
    for (const x of [-3.34, 3.34]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.12, 4.35, CAR_LENGTH), material);
      wall.position.set(x, 2.0, center);
      wall.layers.set(2);
      group.add(wall);
    }
    for (const y of [-0.05, 4.15]) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(6.7, 0.12, CAR_LENGTH), material);
      slab.position.set(0, y, center);
      slab.layers.set(2);
      group.add(slab);
    }
  }
  return { group, material };
}

export function createTrain(materials: TrainMaterials): TrainRig {
  const root = new THREE.Group();
  root.name = 'continuous-armored-train';
  const carBodies: THREE.Group[] = [];
  const wheels: THREE.Group[] = [];
  const bogies: THREE.Group[] = [];
  const doors: THREE.Group[] = [];
  const fans: THREE.Object3D[] = [];
  const hanging: THREE.Object3D[] = [];
  const powered: PoweredRig[] = [];
  const alarmMaterials: THREE.MeshStandardMaterial[] = [];
  const sharedLamp = materials.lamp.clone();
  const sharedAlarm = materials.warning.clone();
  alarmMaterials.push(sharedAlarm);
  const frontTurretParts = createTurret(materials);
  const rearTurretParts = createTurret(materials);
  const upgradeVariants = createUpgradeVariants(materials);
  const collisionHull = createCameraCollisionHull();

  CAR_CENTERS.forEach((center, index) => {
    const car = buildShell(materials, index, center, sharedLamp);
    carBodies.push(car);
    root.add(car);
    for (const localZ of [-5.3, 5.3]) {
      const assembly = makeWheelAssembly(materials, center + localZ);
      root.add(assembly.bogie);
      bogies.push(assembly.bogie);
      wheels.push(...assembly.wheels);
    }
    // Red caged alarm lamps are cloned geometry but share one animated emissive material.
    for (const localZ of [-6.8, 6.8]) {
      const lamp = new THREE.Group();
      const bulb = makeMesh(new THREE.SphereGeometry(0.12, 14, 9), sharedAlarm);
      lamp.add(bulb);
      const cage = makeMesh(new THREE.TorusGeometry(0.15, 0.025, 6, 14), materials.brass);
      cage.rotation.x = Math.PI / 2;
      lamp.add(cage);
      lamp.position.set(0, 3.9, center + localZ);
      root.add(lamp);
    }
  });

  for (const z of [-18, 0, 18]) {
    const door = makeDoor(materials, z);
    root.add(door);
    doors.push(door);
    const gangway = makeMesh(new THREE.TorusGeometry(2.55, 0.13, 8, 24, Math.PI), materials.rubber);
    gangway.position.set(0, 1.72, z);
    gangway.rotation.z = Math.PI / 2;
    root.add(gangway);
  }

  controlInterior(carBodies[0], materials, powered, fans, frontTurretParts.turret);
  engineeringInterior(carBodies[1], materials, powered, fans);
  passengerInterior(carBodies[2], materials, powered);
  defenseInterior(carBodies[3], materials, powered, rearTurretParts.turret);

  for (const z of [-13, 7, 21]) {
    const cord = new THREE.Group();
    const wire = cylinder(0.018, 1.25, materials.rubber, 7);
    wire.position.y = -0.58;
    cord.add(wire);
    const handle = makeMesh(roundedBox(0.3, 0.46, 0.14, 0.1, 3), materials.leather);
    handle.position.y = -1.25;
    cord.add(handle);
    cord.position.set(2.75, 4.02, z);
    root.add(cord);
    hanging.push(cord);
  }

  upgradeVariants.forEach((variant) => root.add(variant));
  root.add(collisionHull.group);

  // Collapse the authored car kit only after every fitting has been placed.
  // Fans, the hero turret, and moving machinery retain independent transforms.
  carBodies.forEach((car) => {
    const dynamic = new Set<THREE.Object3D>();
    fans.forEach((object) => { if (isWithin(object, car)) dynamic.add(object); });
    if (isWithin(frontTurretParts.turret, car)) dynamic.add(frontTurretParts.turret);
    if (isWithin(rearTurretParts.turret, car)) dynamic.add(rearTurretParts.turret);
    mergeStaticByMaterial(car, dynamic);
  });
  const wheelInstances = createInstancedFromAnchors(wheels, root, 'instanced-wheel-sets');
  const bogieInstances = createInstancedFromAnchors(bogies, root, 'instanced-bogie-frames');
  const instanceDummy = new THREE.Object3D();
  updateInstances(wheelInstances, wheels, root, instanceDummy);
  updateInstances(bogieInstances, bogies, root, instanceDummy);

  return {
    root, carBodies, wheels, bogies, doors, fans, hanging, powered, alarmMaterials,
    turret: rearTurretParts.turret,
    muzzle: rearTurretParts.muzzle,
    cameraCollision: collisionHull.group,
    upgradeVariants,
    update(state, elapsed, dt) {
      const speedFactor = Math.max(0.1, state.speed / 48);
      for (const wheel of wheels) wheel.rotation.x -= dt * state.speed * 0.48;
      bogies.forEach((bogie, i) => {
        bogie.position.y = -1.15 + Math.sin(elapsed * (8 + speedFactor * 7) + i * 1.7) * (0.018 + speedFactor * 0.026);
        bogie.rotation.z = Math.sin(elapsed * 2.1 + i) * 0.006;
      });
      carBodies.forEach((car, i) => {
        car.rotation.z = Math.sin(elapsed * 1.22 + i * 0.76) * (0.004 + speedFactor * 0.006);
        car.position.y = Math.sin(elapsed * 7.7 + i * 0.9) * 0.012 * speedFactor;
      });
      const locksOn = state.systems.locks.powered;
      doors.forEach((door, i) => {
        const opened = !locksOn && state.alarm ? 0.74 : 0;
        const ease = 1 - Math.exp(-dt * 5);
        door.children[0].position.x = THREE.MathUtils.lerp(door.children[0].position.x, -1.08 - opened, ease);
        door.children[1].position.x = THREE.MathUtils.lerp(door.children[1].position.x, 1.08 + opened, ease);
        door.rotation.y = Math.sin(elapsed * 1.1 + i) * 0.006;
      });
      fans.forEach((fan, i) => {
        const running = i === 0 ? state.systems.radar.powered : state.systems.cooling.powered;
        if (running) fan.rotation.z -= dt * (i === 0 ? 1.8 : 9);
      });
      hanging.forEach((object, i) => {
        object.rotation.z = Math.sin(elapsed * 1.55 + i * 1.8) * 0.11 + Math.sin(elapsed * 8.5) * 0.018 * speedFactor;
      });
      powered.forEach((rig) => {
        const on = state.systems[rig.id].powered;
        rig.objects.forEach((object) => { object.visible = true; object.userData.powered = on; });
        rig.emissive.forEach((material) => { material.emissiveIntensity = on ? 1.45 : 0.035; });
      });
      sharedLamp.emissiveIntensity = state.systems.lights.powered ? (state.alarm ? 1.25 : 3.2) : 0.015;
      sharedLamp.color.set(state.systems.lights.powered ? '#f3c16f' : '#312c28');
      sharedAlarm.emissiveIntensity = state.alarm && Math.sin(elapsed * 11) > -0.15 ? 4.5 : 0.06;
      // Gameplay owns traverse. The modeled barrels face -Z, therefore PI maps
      // gameplay yaw 0 to the rear/+Z firing direction with no ambient sine sweep.
      rearTurretParts.turret.rotation.y = THREE.MathUtils.lerp(
        rearTurretParts.turret.rotation.y,
        Math.PI + state.turretYaw,
        1 - Math.exp(-dt * 18),
      );
      frontTurretParts.turret.rotation.y = THREE.MathUtils.lerp(frontTurretParts.turret.rotation.y, 0, 1 - Math.exp(-dt * 8));
      const purchased = new Set(state.upgrades.filter((upgrade) => upgrade.purchased).map((upgrade) => upgrade.id));
      upgradeVariants.forEach((variant, id) => { variant.visible = purchased.has(id); });
      updateInstances(wheelInstances, wheels, root, instanceDummy);
      updateInstances(bogieInstances, bogies, root, instanceDummy);
    },
    dispose() {
      collisionHull.material.dispose();
    },
  };
}
