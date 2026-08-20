import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { EnemyState, EnemyType, GameState, PlayerState } from '../shared/types';
import type { TrainMaterials } from './materials';
import { makeMesh } from './materials';

interface SkeletalActor {
  root: THREE.Group;
  skin: THREE.SkinnedMesh;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  bones: Map<string, THREE.Bone>;
  ownedMaterials: THREE.Material[];
  activeAction: string;
}

export interface PlayerRig {
  root: THREE.Group;
  skin: THREE.SkinnedMesh;
  mixer: THREE.AnimationMixer;
  weaponMount: THREE.Group;
  muzzle: THREE.Object3D;
  update(player: PlayerState, dt: number, elapsed: number): void;
  aimAt(target: THREE.Vector3, active: boolean): void;
}

interface EnemyVisual extends SkeletalActor {
  type: EnemyType;
  stateId: number;
}

export interface EnemyRig {
  root: THREE.Group;
  update(enemies: EnemyState[], dt: number, elapsed: number): void;
  dispose(): void;
}

export interface CrewRig {
  root: THREE.Group;
  update(state: GameState, dt: number, elapsed: number, camera?: THREE.Vector3, focus?: THREE.Vector3): void;
  dispose(): void;
}

interface BoneDefinition { name: string; parent?: string; position: THREE.Vector3 }
interface PartDefinition {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  bone: string;
  position: THREE.Vector3;
  rotation?: THREE.Euler;
  scale?: THREE.Vector3;
}

function latheProfile(points: readonly [number, number][], segments = 28) {
  return new THREE.LatheGeometry(points.map(([radius, y]) => new THREE.Vector2(radius, y)), segments);
}

function extrudedProfile(points: readonly [number, number][], depth: number, bevel = .035) {
  const shape = new THREE.Shape();
  points.forEach(([x, y], index) => index === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y));
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize: bevel,
    bevelThickness: bevel,
    curveSegments: 6,
  });
  geometry.translate(0, 0, -depth * .5);
  return geometry;
}

/** Smooth custom sweep with an authored centerline and elliptical ring profile. */
function sweptProfile(points: THREE.Vector3[], radii: readonly [number, number][], radialSegments = 14) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', .35);
  const rings = Math.max(5, points.length * 4);
  const frames = curve.computeFrenetFrames(rings - 1, false);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring < rings; ring += 1) {
    const t = ring / (rings - 1);
    const point = curve.getPoint(t);
    const radiusIndex = Math.min(radii.length - 1, Math.round(t * (radii.length - 1)));
    const [rx, ry] = radii[radiusIndex];
    const normal = frames.normals[ring];
    const binormal = frames.binormals[ring];
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = segment / radialSegments * Math.PI * 2;
      const offset = normal.clone().multiplyScalar(Math.cos(angle) * rx).addScaledVector(binormal, Math.sin(angle) * ry);
      positions.push(point.x + offset.x, point.y + offset.y, point.z + offset.z);
      uvs.push(segment / radialSegments, t);
      if (ring < rings - 1) {
        const next = (segment + 1) % radialSegments;
        const a = ring * radialSegments + segment;
        const b = ring * radialSegments + next;
        const c = (ring + 1) * radialSegments + next;
        const d = (ring + 1) * radialSegments + segment;
        indices.push(a, b, d, b, c, d);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function mantaGeometry(radius = .78, lobes = 8, segments = 48) {
  const positions: number[] = [0, .12, 0, 0, -.13, 0];
  const uvs: number[] = [.5, .5, .5, .5];
  const indices: number[] = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = i / segments * Math.PI * 2;
    const lobe = .74 + Math.pow(Math.abs(Math.sin(angle * lobes * .5)), 1.5) * .26;
    const sideStretch = .82 + Math.abs(Math.sin(angle)) * .35;
    const x = Math.cos(angle) * radius * lobe * sideStretch;
    const z = Math.sin(angle) * radius * lobe;
    positions.push(x, Math.sin(angle * 4) * .045, z, x * .92, -.1, z * .92);
    uvs.push(.5 + x, .5 + z, .5 + x, .5 + z);
  }
  for (let i = 0; i < segments; i += 1) {
    const next = (i + 1) % segments;
    const top = 2 + i * 2, topNext = 2 + next * 2;
    const bottom = top + 1, bottomNext = topNext + 1;
    indices.push(0, top, topNext, 1, bottomNext, bottom, top, bottom, topNext, topNext, bottom, bottomNext);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function transformGeometry(source: THREE.BufferGeometry, position: THREE.Vector3, rotation = new THREE.Euler(), scale = new THREE.Vector3(1, 1, 1)) {
  const geometry = source.index ? source.toNonIndexed() : source.clone();
  source.dispose();
  geometry.applyMatrix4(new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(rotation), scale));
  return geometry;
}

function skinnedGeometry(parts: PartDefinition[], boneIndex: Map<string, number>) {
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const part of parts) {
    const geometry = transformGeometry(part.geometry, part.position, part.rotation, part.scale);
    const count = geometry.getAttribute('position').count;
    const indices = new Uint16Array(count * 4);
    const weights = new Float32Array(count * 4);
    const index = boneIndex.get(part.bone) ?? 0;
    for (let vertex = 0; vertex < count; vertex += 1) {
      indices[vertex * 4] = index;
      weights[vertex * 4] = 1;
    }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    const list = byMaterial.get(part.material) ?? [];
    list.push(geometry);
    byMaterial.set(part.material, list);
  }
  const materialGeometry: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  for (const [material, geometries] of byMaterial) {
    const merged = mergeGeometries(geometries, false);
    geometries.forEach((geometry) => geometry.dispose());
    if (!merged) continue;
    materialGeometry.push(merged);
    materials.push(material);
  }
  const geometry = mergeGeometries(materialGeometry, true);
  materialGeometry.forEach((entry) => entry.dispose());
  if (!geometry) throw new Error('Unable to assemble procedural skinned actor');
  geometry.computeBoundingSphere();
  return { geometry, materials };
}

function makeBones(definitions: BoneDefinition[]) {
  const bones = new Map<string, THREE.Bone>();
  for (const definition of definitions) {
    const bone = new THREE.Bone();
    bone.name = definition.name;
    bone.position.copy(definition.position);
    bones.set(definition.name, bone);
  }
  for (const definition of definitions) {
    if (definition.parent) bones.get(definition.parent)?.add(bones.get(definition.name)!);
  }
  return bones;
}

/**
 * Procedural-original rig pipeline: custom lathed profiles, beveled garment
 * silhouettes, and anatomical spline sweeps are baked into one weighted
 * BufferGeometry, bound to a real Skeleton, and driven by AnimationMixer clips.
 * Standard primitives are reserved for small tool fittings, not actor anatomy.
 */
function makeActor(definitions: BoneDefinition[], parts: PartDefinition[], clips: THREE.AnimationClip[], ownedMaterials: THREE.Material[] = []): SkeletalActor {
  const index = new Map(definitions.map((definition, i) => [definition.name, i]));
  const built = skinnedGeometry(parts, index);
  const bones = makeBones(definitions);
  const skin = new THREE.SkinnedMesh(built.geometry, built.materials);
  skin.name = 'procedural-original-skinned-mesh';
  skin.castShadow = true;
  skin.receiveShadow = true;
  skin.frustumCulled = false;
  skin.add(bones.get(definitions[0].name)!);
  skin.bind(new THREE.Skeleton(definitions.map((definition) => bones.get(definition.name)!)));
  const root = new THREE.Group();
  root.add(skin);
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<string, THREE.AnimationAction>();
  clips.forEach((clip) => actions.set(clip.name, mixer.clipAction(clip)));
  const first = clips[0]?.name ?? '';
  if (first) actions.get(first)?.play();
  return { root, skin, mixer, actions, bones, ownedMaterials, activeAction: first };
}

function setAction(actor: SkeletalActor, name: string, fade = 0.16) {
  if (name === actor.activeAction) return;
  const previous = actor.actions.get(actor.activeAction);
  const next = actor.actions.get(name);
  if (!next) return;
  next.reset().play();
  if (previous) previous.crossFadeTo(next, fade, false);
  actor.activeAction = name;
}

function humanBones(): BoneDefinition[] {
  return [
    { name: 'Root', position: new THREE.Vector3() },
    { name: 'Spine', parent: 'Root', position: new THREE.Vector3(0, 1.2, 0) },
    { name: 'Head', parent: 'Spine', position: new THREE.Vector3(0, 1.14, 0) },
    { name: 'LeftArm', parent: 'Spine', position: new THREE.Vector3(-0.47, 0.78, 0) },
    { name: 'LeftForeArm', parent: 'LeftArm', position: new THREE.Vector3(0, -0.58, 0) },
    { name: 'RightArm', parent: 'Spine', position: new THREE.Vector3(0.47, 0.78, 0) },
    { name: 'RightForeArm', parent: 'RightArm', position: new THREE.Vector3(0, -0.58, 0) },
    { name: 'LeftLeg', parent: 'Root', position: new THREE.Vector3(-0.22, 1.12, 0) },
    { name: 'LeftShin', parent: 'LeftLeg', position: new THREE.Vector3(0, -0.67, 0) },
    { name: 'RightLeg', parent: 'Root', position: new THREE.Vector3(0.22, 1.12, 0) },
    { name: 'RightShin', parent: 'RightLeg', position: new THREE.Vector3(0, -0.67, 0) },
  ];
}

function humanClips() {
  return [
    new THREE.AnimationClip('idle', 2.4, [
      new THREE.NumberKeyframeTrack('Spine.position[y]', [0, 1.2, 2.4], [1.2, 1.235, 1.2]),
      new THREE.NumberKeyframeTrack('Head.rotation[y]', [0, 1.2, 2.4], [-0.05, 0.06, -0.05]),
      new THREE.NumberKeyframeTrack('LeftArm.rotation[z]', [0, 1.2, 2.4], [0.08, 0.13, 0.08]),
      new THREE.NumberKeyframeTrack('RightArm.rotation[z]', [0, 1.2, 2.4], [-0.08, -0.13, -0.08]),
    ]),
    new THREE.AnimationClip('walk', 0.72, [
      new THREE.NumberKeyframeTrack('LeftLeg.rotation[x]', [0, .18, .36, .54, .72], [-.58, 0, .58, 0, -.58]),
      new THREE.NumberKeyframeTrack('RightLeg.rotation[x]', [0, .18, .36, .54, .72], [.58, 0, -.58, 0, .58]),
      new THREE.NumberKeyframeTrack('LeftShin.rotation[x]', [0, .18, .36, .54, .72], [.55, .12, 0, .12, .55]),
      new THREE.NumberKeyframeTrack('RightShin.rotation[x]', [0, .18, .36, .54, .72], [0, .12, .55, .12, 0]),
      new THREE.NumberKeyframeTrack('LeftArm.rotation[x]', [0, .36, .72], [.48, -.48, .48]),
      new THREE.NumberKeyframeTrack('RightArm.rotation[x]', [0, .36, .72], [-.48, .48, -.48]),
      new THREE.NumberKeyframeTrack('Spine.position[y]', [0, .18, .36, .54, .72], [1.2, 1.23, 1.2, 1.23, 1.2]),
    ]),
    new THREE.AnimationClip('aim', 1.4, [
      new THREE.NumberKeyframeTrack('RightArm.rotation[x]', [0, .7, 1.4], [-1.18, -1.14, -1.18]),
      new THREE.NumberKeyframeTrack('RightForeArm.rotation[x]', [0, .7, 1.4], [-.3, -.24, -.3]),
      new THREE.NumberKeyframeTrack('LeftArm.rotation[x]', [0, .7, 1.4], [-.7, -.65, -.7]),
      new THREE.NumberKeyframeTrack('Spine.rotation[y]', [0, .7, 1.4], [.12, .15, .12]),
    ]),
    new THREE.AnimationClip('alarm', 1.05, [
      new THREE.NumberKeyframeTrack('Head.rotation[y]', [0, .25, .52, .78, 1.05], [-.42, .32, -.2, .42, -.42]),
      new THREE.NumberKeyframeTrack('LeftArm.rotation[x]', [0, .52, 1.05], [-.28, -.72, -.28]),
      new THREE.NumberKeyframeTrack('RightArm.rotation[x]', [0, .52, 1.05], [-.7, -.22, -.7]),
    ]),
    new THREE.AnimationClip('work', .84, [
      new THREE.NumberKeyframeTrack('Spine.rotation[x]', [0, .42, .84], [.18, .27, .18]),
      new THREE.NumberKeyframeTrack('LeftArm.rotation[x]', [0, .21, .42, .63, .84], [-.62, -1.05, -.76, -1.16, -.62]),
      new THREE.NumberKeyframeTrack('RightArm.rotation[x]', [0, .21, .42, .63, .84], [-1.08, -.7, -1.18, -.78, -1.08]),
      new THREE.NumberKeyframeTrack('LeftForeArm.rotation[z]', [0, .42, .84], [-.16, .22, -.16]),
      new THREE.NumberKeyframeTrack('Head.rotation[x]', [0, .42, .84], [.16, .28, .16]),
    ]),
    new THREE.AnimationClip('shelter', 1.6, [
      new THREE.NumberKeyframeTrack('Spine.rotation[x]', [0, .8, 1.6], [.4, .46, .4]),
      new THREE.NumberKeyframeTrack('Spine.position[y]', [0, .8, 1.6], [.93, .9, .93]),
      new THREE.NumberKeyframeTrack('LeftArm.rotation[x]', [0, .8, 1.6], [-1.55, -1.48, -1.55]),
      new THREE.NumberKeyframeTrack('RightArm.rotation[x]', [0, .8, 1.6], [-1.55, -1.48, -1.55]),
      new THREE.NumberKeyframeTrack('Head.rotation[x]', [0, .8, 1.6], [-.3, -.38, -.3]),
    ]),
  ];
}

function createHuman(materials: TrainMaterials, coat: THREE.Material, scale = 1, ownedMaterials: THREE.Material[] = []) {
  const torso = () => extrudedProfile([
    [-.27, -.55], [-.38, -.28], [-.47, .34], [-.34, .58], [0, .66], [.34, .58], [.47, .34], [.38, -.28], [.27, -.55],
  ], .52, .055);
  const chestPlate = () => extrudedProfile([[-.31, -.28], [-.38, .17], [-.25, .32], [0, .38], [.25, .32], [.38, .17], [.31, -.28]], .13, .04);
  const backpack = () => extrudedProfile([[-.28, -.4], [-.35, -.23], [-.33, .34], [-.19, .47], [.19, .47], [.33, .34], [.35, -.23], [.28, -.4]], .24, .06);
  const head = () => latheProfile([[.08, -.3], [.19, -.25], [.245, -.08], [.235, .1], [.18, .28], [.06, .34]], 30);
  const helmet = () => latheProfile([[.255, -.035], [.27, .04], [.245, .16], [.17, .27], [.04, .32]], 30);
  const upperArm = () => sweptProfile(
    [new THREE.Vector3(0, .29, 0), new THREE.Vector3(0, .09, .015), new THREE.Vector3(.012, -.13, .035), new THREE.Vector3(0, -.3, .02)],
    [[.15, .135], [.145, .13], [.125, .115], [.105, .1]], 16,
  );
  const foreArm = () => sweptProfile(
    [new THREE.Vector3(0, .27, 0), new THREE.Vector3(.015, .08, -.015), new THREE.Vector3(0, -.12, -.045), new THREE.Vector3(0, -.29, -.06)],
    [[.12, .11], [.13, .115], [.105, .095], [.08, .075]], 16,
  );
  const thigh = () => sweptProfile(
    [new THREE.Vector3(0, .33, 0), new THREE.Vector3(.012, .12, .015), new THREE.Vector3(0, -.12, -.015), new THREE.Vector3(0, -.34, 0)],
    [[.18, .16], [.17, .155], [.145, .14], [.12, .115]], 16,
  );
  const shin = () => sweptProfile(
    [new THREE.Vector3(0, .31, 0), new THREE.Vector3(-.012, .08, .025), new THREE.Vector3(0, -.16, -.01), new THREE.Vector3(0, -.32, -.035)],
    [[.135, .125], [.145, .13], [.115, .105], [.09, .085]], 16,
  );
  const glove = () => extrudedProfile([[-.09, -.16], [-.12, .03], [-.08, .15], [.04, .18], [.12, .07], [.105, -.14], [.04, -.2]], .17, .035);
  const boot = () => extrudedProfile([[-.31, -.12], [-.2, .12], [.12, .16], [.23, .02], [.28, -.13], [.16, -.2], [-.25, -.2]], .27, .045);
  const shoulder = () => latheProfile([[.18, -.1], [.205, -.025], [.19, .08], [.11, .14], [.02, .15]], 20);
  const parts: PartDefinition[] = [
    { geometry: torso(), material: coat, bone: 'Spine', position: new THREE.Vector3(0, 1.66, 0) },
    { geometry: chestPlate(), material: materials.armor, bone: 'Spine', position: new THREE.Vector3(0, 1.75, -.31) },
    { geometry: backpack(), material: materials.armor, bone: 'Spine', position: new THREE.Vector3(0, 1.67, .32), scale: new THREE.Vector3(.78, .82, .78) },
    { geometry: new THREE.TorusKnotGeometry(.13, .024, 46, 6, 2, 7), material: materials.copper, bone: 'Spine', position: new THREE.Vector3(0, 1.67, .51) },
    { geometry: extrudedProfile([[-.045, -.31], [-.075, -.22], [-.07, .26], [-.035, .34], [.035, .34], [.07, .26], [.075, -.22], [.045, -.31]], .035, .012), material: materials.brass, bone: 'Spine', position: new THREE.Vector3(0, 1.68, .5) },
    { geometry: extrudedProfile([[-.19, -.035], [-.15, .055], [.15, .055], [.19, -.035], [.14, -.095], [-.14, -.095]], .03, .01), material: materials.brass, bone: 'Spine', position: new THREE.Vector3(0, 1.95, .49) },
    { geometry: shoulder(), material: materials.armor, bone: 'LeftArm', position: new THREE.Vector3(-.47, 1.99, 0), rotation: new THREE.Euler(0, 0, -.2), scale: new THREE.Vector3(1, .8, 1.15) },
    { geometry: shoulder(), material: materials.armor, bone: 'RightArm', position: new THREE.Vector3(.47, 1.99, 0), rotation: new THREE.Euler(0, 0, .2), scale: new THREE.Vector3(1, .8, 1.15) },
    { geometry: head(), material: materials.bone, bone: 'Head', position: new THREE.Vector3(0, 2.42, -.005), scale: new THREE.Vector3(.92, 1, .88) },
    { geometry: extrudedProfile([[-.055, -.09], [-.075, .025], [-.035, .1], [.02, .075], [.07, -.035], [.04, -.1]], .13, .018), material: materials.bone, bone: 'Head', position: new THREE.Vector3(0, 2.43, -.225) },
    { geometry: helmet(), material: materials.armor, bone: 'Head', position: new THREE.Vector3(0, 2.54, .01), scale: new THREE.Vector3(1, .9, 1.03) },
    { geometry: new THREE.TorusGeometry(.235, .032, 8, 20), material: materials.brass, bone: 'Head', position: new THREE.Vector3(0, 2.42, .01), rotation: new THREE.Euler(Math.PI / 2, 0, 0) },
    { geometry: upperArm(), material: coat, bone: 'LeftArm', position: new THREE.Vector3(-.47, 1.72, 0) },
    { geometry: foreArm(), material: materials.armor, bone: 'LeftForeArm', position: new THREE.Vector3(-.47, 1.15, 0) },
    { geometry: glove(), material: materials.leather, bone: 'LeftForeArm', position: new THREE.Vector3(-.47, .82, -.04) },
    { geometry: upperArm(), material: coat, bone: 'RightArm', position: new THREE.Vector3(.47, 1.72, 0) },
    { geometry: foreArm(), material: materials.armor, bone: 'RightForeArm', position: new THREE.Vector3(.47, 1.15, 0) },
    { geometry: glove(), material: materials.leather, bone: 'RightForeArm', position: new THREE.Vector3(.47, .82, -.04) },
    { geometry: thigh(), material: materials.armor, bone: 'LeftLeg', position: new THREE.Vector3(-.22, .79, 0) },
    { geometry: shin(), material: materials.darkSteel, bone: 'LeftShin', position: new THREE.Vector3(-.22, .27, 0) },
    { geometry: boot(), material: materials.rubber, bone: 'LeftShin', position: new THREE.Vector3(-.22, .08, -.15), rotation: new THREE.Euler(0, Math.PI / 2, 0) },
    { geometry: thigh(), material: materials.armor, bone: 'RightLeg', position: new THREE.Vector3(.22, .79, 0) },
    { geometry: shin(), material: materials.darkSteel, bone: 'RightShin', position: new THREE.Vector3(.22, .27, 0) },
    { geometry: boot(), material: materials.rubber, bone: 'RightShin', position: new THREE.Vector3(.22, .08, -.15), rotation: new THREE.Euler(0, Math.PI / 2, 0) },
    { geometry: new THREE.TorusGeometry(.38, .045, 8, 22), material: materials.brass, bone: 'Spine', position: new THREE.Vector3(0, 1.26, 0), rotation: new THREE.Euler(Math.PI / 2, 0, 0), scale: new THREE.Vector3(1, 1, .74) },
    { geometry: extrudedProfile([[-.26, -.5], [-.33, .12], [-.08, .28], [0, -.54]], .2, .025), material: coat, bone: 'Spine', position: new THREE.Vector3(-.12, 1.14, .08) },
    { geometry: extrudedProfile([[.26, -.5], [.33, .12], [.08, .28], [0, -.54]], .2, .025), material: coat, bone: 'Spine', position: new THREE.Vector3(.12, 1.14, .08) },
    { geometry: extrudedProfile([[-.13, -.24], [-.26, .27], [-.05, .18], [.04, -.2]], .055, .015), material: materials.brass, bone: 'Spine', position: new THREE.Vector3(-.09, 1.76, -.39) },
    { geometry: extrudedProfile([[.13, -.24], [.26, .27], [.05, .18], [-.04, -.2]], .055, .015), material: materials.brass, bone: 'Spine', position: new THREE.Vector3(.09, 1.76, -.39) },
  ];
  const actor = makeActor(humanBones(), parts, humanClips(), ownedMaterials);
  actor.root.scale.setScalar(scale);
  return actor;
}

function createWeaponMount(materials: TrainMaterials, hand: THREE.Bone) {
  const mount = new THREE.Group();
  mount.position.set(0, -.53, -.12);
  mount.rotation.x = -1.35;
  const wrench = new THREE.Group(); wrench.name = 'wrench';
  const shaft = makeMesh(new THREE.CylinderGeometry(.035, .035, .86, 10), materials.steel);
  shaft.rotation.z = Math.PI / 2; wrench.add(shaft);
  const jaw = makeMesh(new THREE.TorusGeometry(.15, .045, 7, 16, Math.PI * 1.45), materials.steel);
  jaw.position.x = -.5; jaw.rotation.z = -.72; wrench.add(jaw);
  const sidearm = new THREE.Group(); sidearm.name = 'sidearm';
  sidearm.add(makeMesh(new THREE.BoxGeometry(.18, .25, .62, 2, 2, 3), materials.darkSteel));
  const barrel = makeMesh(new THREE.CylinderGeometry(.045, .045, .72, 12), materials.brass);
  barrel.rotation.x = Math.PI / 2; barrel.position.z = -.35; sidearm.add(barrel);
  sidearm.scale.setScalar(1.22);
  const arc = new THREE.Group(); arc.name = 'arc-tool';
  const arcBody = makeMesh(new THREE.CapsuleGeometry(.2, .42, 5, 14), materials.armor); arcBody.rotation.x = Math.PI / 2; arc.add(arcBody);
  for (const x of [-.08, .08]) {
    const prong = makeMesh(new THREE.CylinderGeometry(.025, .025, .42, 8), materials.copper);
    prong.rotation.x = Math.PI / 2; prong.position.set(x, 0, -.48); arc.add(prong);
  }
  mount.add(wrench, sidearm, arc);
  const muzzle = new THREE.Object3D();
  muzzle.name = 'player-handheld-muzzle';
  muzzle.position.set(0, 0, -.9);
  mount.add(muzzle);
  hand.add(mount);
  return { mount, muzzle };
}

export function createPlayer(materials: TrainMaterials): PlayerRig {
  // The train is deliberately claustrophobic, but the hero should not consume
  // the entire aisle or camera frame. Presentation scale is independent of the
  // authoritative gameplay capsule and movement coordinates.
  const actor = createHuman(materials, materials.leather, 0.84);
  actor.root.name = 'skinned-player-engineer';
  const { mount: weaponMount, muzzle } = createWeaponMount(materials, actor.bones.get('RightForeArm')!);
  const lastPosition = new THREE.Vector3();
  const weaponPosition = new THREE.Vector3();
  const weaponDirection = new THREE.Vector3();
  const weaponWorldQuaternion = new THREE.Quaternion();
  const weaponParentQuaternion = new THREE.Quaternion();
  const weaponForward = new THREE.Vector3(0, 0, -1);
  let initialized = false;
  return {
    root: actor.root, skin: actor.skin, mixer: actor.mixer, weaponMount, muzzle,
    update(player, dt, elapsed) {
      actor.root.position.set(player.position.x, player.position.y, player.position.z);
      actor.root.rotation.y = player.yaw;
      if (!initialized) { lastPosition.copy(actor.root.position); initialized = true; }
      const speed = player.moveSpeed;
      setAction(actor, player.aiming ? 'aim' : speed > .15 ? 'walk' : 'idle');
      const walk = actor.actions.get('walk');
      if (walk) walk.timeScale = player.sprinting ? 1.55 : THREE.MathUtils.clamp(speed / 4.4, .72, 1.2);
      actor.mixer.update(dt);
      actor.root.rotation.z = player.dodging ? Math.sin(elapsed * 16) * .34 : THREE.MathUtils.lerp(actor.root.rotation.z, 0, 1 - Math.exp(-dt * 12));
      weaponMount.rotation.x = player.aiming ? -.28 : player.equipment === 'sidearm' ? -.82 : -1.35;
      weaponMount.children.forEach((weapon) => { weapon.visible = weapon.name === player.equipment; });
      lastPosition.copy(actor.root.position);
    },
    aimAt(target, active) {
      if (!active || !weaponMount.parent) return;
      actor.root.updateWorldMatrix(true, true);
      weaponMount.getWorldPosition(weaponPosition);
      weaponDirection.subVectors(target, weaponPosition);
      if (weaponDirection.lengthSq() < 0.001) return;
      weaponDirection.normalize();
      weaponWorldQuaternion.setFromUnitVectors(weaponForward, weaponDirection);
      weaponMount.parent.getWorldQuaternion(weaponParentQuaternion).invert();
      weaponMount.quaternion.copy(weaponParentQuaternion.multiply(weaponWorldQuaternion));
      weaponMount.updateWorldMatrix(false, true);
    },
  };
}

function enemyClips(type: EnemyType, limbNames: string[]) {
  const tracks: THREE.KeyframeTrack[] = [new THREE.NumberKeyframeTrack('Body.position[y]', [0, .28, .56], [0, type === 'clinger' ? .07 : .035, 0])];
  limbNames.forEach((name, index) => {
    const side = index % 2 ? 1 : -1;
    if (type === 'clinger') {
      tracks.push(new THREE.NumberKeyframeTrack(`${name}.rotation[z]`, [0, .14, .28, .42, .56], [side * .2, side * -.48, side * .12, side * .55, side * .2]));
      tracks.push(new THREE.NumberKeyframeTrack(`${name}.rotation[x]`, [0, .28, .56], [-.22, .32, -.22]));
    } else {
      tracks.push(new THREE.NumberKeyframeTrack(`${name}.rotation[y]`, [0, .28, .56], [side * -.18, side * .38, side * -.18]));
      tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, [0, .28, .56], [1, 1, 1, 1.18, .82, 1.12, 1, 1, 1]));
    }
  });
  return [
    new THREE.AnimationClip('prowl', .56, tracks),
    new THREE.AnimationClip('attack', .46, [
      new THREE.NumberKeyframeTrack('Head.rotation[x]', [0, .18, .3, .46], [0, -.62, .22, 0]),
      ...limbNames.map((name, index) => new THREE.NumberKeyframeTrack(`${name}.rotation[z]`, [0, .18, .3, .46], [0, (index % 2 ? -1 : 1) * .84, (index % 2 ? 1 : -1) * .35, 0])),
    ]),
  ];
}

function ripperClips() {
  return [
    new THREE.AnimationClip('walk', .92, [
      new THREE.NumberKeyframeTrack('LeftLeg.rotation[x]', [0, .46, .92], [-.34, .34, -.34]),
      new THREE.NumberKeyframeTrack('RightLeg.rotation[x]', [0, .46, .92], [.34, -.34, .34]),
      new THREE.NumberKeyframeTrack('LeftArm.rotation[x]', [0, .46, .92], [.26, -.38, .26]),
      new THREE.NumberKeyframeTrack('RightArm.rotation[x]', [0, .46, .92], [-.38, .26, -.38]),
      new THREE.NumberKeyframeTrack('Spine.rotation[x]', [0, .46, .92], [.2, .26, .2]),
    ]),
    new THREE.AnimationClip('alarm', .66, [
      new THREE.NumberKeyframeTrack('LeftArm.rotation[x]', [0, .2, .42, .66], [-.25, -1.45, -.72, -.25]),
      new THREE.NumberKeyframeTrack('RightArm.rotation[x]', [0, .2, .42, .66], [-.72, -1.45, -.25, -.72]),
      new THREE.NumberKeyframeTrack('LeftForeArm.rotation[x]', [0, .3, .66], [-.2, -.88, -.2]),
      new THREE.NumberKeyframeTrack('RightForeArm.rotation[x]', [0, .3, .66], [-.2, -.88, -.2]),
      new THREE.NumberKeyframeTrack('Head.rotation[x]', [0, .3, .66], [.1, -.42, .1]),
    ]),
  ];
}

function createRipperActor(materials: TrainMaterials) {
  const bones = humanBones();
  const arm = () => sweptProfile(
    [new THREE.Vector3(0, .38, 0), new THREE.Vector3(.02, .12, -.04), new THREE.Vector3(.04, -.17, -.1), new THREE.Vector3(0, -.42, -.13)],
    [[.25, .23], [.27, .24], [.23, .21], [.17, .16]], 18,
  );
  const fore = () => sweptProfile(
    [new THREE.Vector3(0, .42, 0), new THREE.Vector3(0, .12, -.06), new THREE.Vector3(.025, -.2, -.13), new THREE.Vector3(0, -.48, -.2)],
    [[.19, .18], [.24, .21], [.2, .18], [.13, .12]], 18,
  );
  const leg = () => sweptProfile(
    [new THREE.Vector3(0, .31, 0), new THREE.Vector3(.03, .08, .08), new THREE.Vector3(0, -.2, .04), new THREE.Vector3(-.02, -.36, -.02)],
    [[.2, .18], [.19, .17], [.15, .14], [.12, .11]], 16,
  );
  const parts: PartDefinition[] = [
    { geometry: extrudedProfile([[-.43, -.55], [-.62, -.22], [-.7, .34], [-.48, .68], [0, .82], [.48, .68], [.7, .34], [.62, -.22], [.43, -.55]], .66, .075), material: materials.enemyHide, bone: 'Spine', position: new THREE.Vector3(0, 1.7, .06), rotation: new THREE.Euler(.18, 0, 0) },
    { geometry: extrudedProfile([[-.52, -.34], [-.64, .19], [-.35, .43], [0, .51], [.35, .43], [.64, .19], [.52, -.34]], .16, .05), material: materials.darkSteel, bone: 'Spine', position: new THREE.Vector3(0, 1.82, -.39) },
    { geometry: latheProfile([[.1, -.3], [.28, -.23], [.33, -.02], [.27, .18], [.16, .32], [.035, .36]], 26), material: materials.bone, bone: 'Head', position: new THREE.Vector3(0, 2.52, -.08), scale: new THREE.Vector3(1.16, .9, .82) },
    { geometry: extrudedProfile([[-.28, -.13], [-.18, .11], [0, .2], [.18, .11], [.28, -.13], [.12, -.27], [0, -.19], [-.12, -.27]], .24, .035), material: materials.enemyHide, bone: 'Head', position: new THREE.Vector3(0, 2.33, -.32) },
    { geometry: arm(), material: materials.enemyHide, bone: 'LeftArm', position: new THREE.Vector3(-.61, 1.67, 0), rotation: new THREE.Euler(0, 0, -.18) },
    { geometry: arm(), material: materials.enemyHide, bone: 'RightArm', position: new THREE.Vector3(.61, 1.67, 0), rotation: new THREE.Euler(0, 0, .18) },
    { geometry: fore(), material: materials.darkSteel, bone: 'LeftForeArm', position: new THREE.Vector3(-.64, 1.03, -.04) },
    { geometry: fore(), material: materials.darkSteel, bone: 'RightForeArm', position: new THREE.Vector3(.64, 1.03, -.04) },
    { geometry: extrudedProfile([[-.13, -.27], [-.2, .05], [-.08, .22], [.04, .18], [.19, -.12], [.08, -.3]], .22, .035), material: materials.bone, bone: 'LeftForeArm', position: new THREE.Vector3(-.64, .55, -.2), rotation: new THREE.Euler(0, 0, -.32) },
    { geometry: extrudedProfile([[-.13, -.27], [-.2, .05], [-.08, .22], [.04, .18], [.19, -.12], [.08, -.3]], .22, .035), material: materials.bone, bone: 'RightForeArm', position: new THREE.Vector3(.64, .55, -.2), rotation: new THREE.Euler(0, 0, .32) },
    { geometry: leg(), material: materials.enemyHide, bone: 'LeftLeg', position: new THREE.Vector3(-.27, .76, .02) },
    { geometry: leg(), material: materials.enemyHide, bone: 'RightLeg', position: new THREE.Vector3(.27, .76, .02) },
    { geometry: sweptProfile([new THREE.Vector3(0, .28, 0), new THREE.Vector3(0, .02, -.02), new THREE.Vector3(0, -.3, -.12)], [[.13, .12], [.14, .13], [.095, .09]], 14), material: materials.darkSteel, bone: 'LeftShin', position: new THREE.Vector3(-.27, .2, .02) },
    { geometry: sweptProfile([new THREE.Vector3(0, .28, 0), new THREE.Vector3(0, .02, -.02), new THREE.Vector3(0, -.3, -.12)], [[.13, .12], [.14, .13], [.095, .09]], 14), material: materials.darkSteel, bone: 'RightShin', position: new THREE.Vector3(.27, .2, .02) },
  ];
  const actor = makeActor(bones, parts, ripperClips());
  actor.root.name = 'skinned-ripper';
  return actor;
}

function createEnemyActor(type: EnemyType, materials: TrainMaterials) {
  if (type === 'ripper') return createRipperActor(materials);
  const definitions: BoneDefinition[] = [{ name: 'Root', position: new THREE.Vector3() }, { name: 'Body', parent: 'Root', position: new THREE.Vector3() }, { name: 'Head', parent: 'Body', position: new THREE.Vector3(0, 0, -.58) }];
  const parts: PartDefinition[] = [];
  const limbNames: string[] = [];
  const bodyMaterial = type === 'leeche' ? materials.parasite : materials.enemyHide;
  if (type === 'leeche') {
    parts.push({ geometry: mantaGeometry(.78, 8, 56), material: bodyMaterial, bone: 'Body', position: new THREE.Vector3() });
    parts.push({ geometry: new THREE.TorusGeometry(.32, .075, 10, 30), material: materials.copper, bone: 'Body', position: new THREE.Vector3(0, -.13, .02), rotation: new THREE.Euler(Math.PI / 2, 0, 0) });
    parts.push({ geometry: latheProfile([[.04, -.22], [.19, -.14], [.22, .02], [.15, .2], [.035, .25]], 24), material: materials.parasite, bone: 'Head', position: new THREE.Vector3(0, .04, -.48), rotation: new THREE.Euler(Math.PI / 2, 0, 0), scale: new THREE.Vector3(1, 1.25, 1) });
  } else {
    parts.push({ geometry: sweptProfile([new THREE.Vector3(0, 0, .72), new THREE.Vector3(0, .04, .35), new THREE.Vector3(0, .03, 0), new THREE.Vector3(0, -.02, -.38), new THREE.Vector3(0, 0, -.74)], [[.12, .1], [.33, .24], [.43, .31], [.3, .23], [.1, .08]], 18), material: bodyMaterial, bone: 'Body', position: new THREE.Vector3() });
    for (const z of [-.28, .05, .36]) {
      parts.push({ geometry: extrudedProfile([[-.28, -.1], [-.17, .16], [0, .24], [.17, .16], [.28, -.1], [0, -.02]], .08, .02), material: materials.darkSteel, bone: 'Body', position: new THREE.Vector3(0, .25, z), rotation: new THREE.Euler(Math.PI / 2, 0, 0) });
    }
    parts.push({ geometry: latheProfile([[.05, -.24], [.2, -.19], [.27, -.02], [.21, .17], [.08, .25]], 24), material: materials.bone, bone: 'Head', position: new THREE.Vector3(0, 0, -.68), rotation: new THREE.Euler(Math.PI / 2, 0, 0), scale: new THREE.Vector3(.9, 1.15, .78) });
    for (const side of [-1, 1]) parts.push({ geometry: extrudedProfile([[-.04, -.18], [-.08, .1], [0, .3], [.08, .1], [.04, -.18]], .07, .012), material: materials.bone, bone: 'Head', position: new THREE.Vector3(side * .12, -.08, -.91), rotation: new THREE.Euler(Math.PI / 2, 0, side * .16) });
  }
  for (let i = 0; i < 6; i += 1) {
    const name = `Limb${i}`;
    const side = i % 2 ? 1 : -1;
    const row = Math.floor(i / 2);
    definitions.push({ name, parent: 'Body', position: new THREE.Vector3(side * .3, 0, -.38 + row * .42) });
    limbNames.push(name);
    if (type === 'leeche') {
      const angle = i / 6 * Math.PI * 2;
      parts.push({ geometry: sweptProfile([new THREE.Vector3(0, 0, 0), new THREE.Vector3(.24, -.04, .12), new THREE.Vector3(.47, -.16, -.02), new THREE.Vector3(.69, -.24, .18)], [[.06, .045], [.05, .04], [.035, .03], [.012, .012]], 12), material: materials.parasite, bone: name, position: new THREE.Vector3(Math.cos(angle) * .25, -.08, Math.sin(angle) * .25), rotation: new THREE.Euler(0, angle, 0) });
      parts.push({ geometry: extrudedProfile([[-.035, -.11], [0, .16], [.055, -.08]], .035, .008), material: materials.copper, bone: name, position: new THREE.Vector3(Math.cos(angle) * .78, -.27, Math.sin(angle) * .78), rotation: new THREE.Euler(0, angle, 0) });
    } else {
      parts.push({ geometry: sweptProfile([new THREE.Vector3(0, .12, 0), new THREE.Vector3(side * .3, -.04, .04), new THREE.Vector3(side * .56, -.28, .02), new THREE.Vector3(side * .78, -.55, -.08)], [[.09, .075], [.08, .065], [.055, .045], [.028, .024]], 12), material: row === 1 ? materials.bone : materials.enemyHide, bone: name, position: new THREE.Vector3(side * .22, 0, -.38 + row * .42) });
      parts.push({ geometry: extrudedProfile([[-.055, -.14], [-.08, .08], [0, .28], [.07, .06], [.04, -.14]], .055, .012), material: materials.bone, bone: name, position: new THREE.Vector3(side * 1.02, -.58, -.46 + row * .42), rotation: new THREE.Euler(0, 0, side * -.46) });
    }
  }
  const actor = makeActor(definitions, parts, enemyClips(type, limbNames));
  actor.root.name = `skinned-${type}`;
  return actor;
}

function cloneEnemyActor(prototype: SkeletalActor, type: EnemyType): EnemyVisual {
  const root = cloneSkeleton(prototype.root) as THREE.Group;
  const skin = root.getObjectByName('procedural-original-skinned-mesh') as THREE.SkinnedMesh;
  const bones = new Map(skin.skeleton.bones.map((bone) => [bone.name, bone]));
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<string, THREE.AnimationAction>();
  const clips = [...prototype.actions.values()].map((action) => action.getClip());
  clips.forEach((clip) => actions.set(clip.name, mixer.clipAction(clip)));
  const activeAction = clips[0]?.name ?? '';
  if (activeAction) actions.get(activeAction)?.play();
  return { root, skin, bones, mixer, actions, ownedMaterials: [], activeAction, type, stateId: -1 };
}

export function createEnemyRig(materials: TrainMaterials, maxEnemies = 18): EnemyRig {
  const root = new THREE.Group(); root.name = 'skinned-enemy-pool';
  const prototypes = new Map<EnemyType, SkeletalActor>([
    ['clinger', createEnemyActor('clinger', materials)],
    ['leeche', createEnemyActor('leeche', materials)],
    ['ripper', createEnemyActor('ripper', materials)],
  ]);
  const visuals: EnemyVisual[] = [];
  for (let i = 0; i < maxEnemies; i += 1) {
    const type: EnemyType = i % 3 === 0 ? 'clinger' : i % 3 === 1 ? 'leeche' : 'ripper';
    const visual = cloneEnemyActor(prototypes.get(type)!, type);
    visual.root.visible = false; root.add(visual.root); visuals.push(visual);
  }
  const byId = new Map<number, EnemyVisual>();
  return {
    root,
    update(enemies, dt, elapsed) {
      const activeIds = new Set(enemies.filter((enemy) => enemy.stage !== 'dead').map((enemy) => enemy.id));
      byId.forEach((visual, id) => {
        if (!activeIds.has(id)) { visual.root.visible = false; visual.stateId = -1; byId.delete(id); }
      });
      enemies.forEach((enemy) => {
        if (enemy.stage === 'dead') return;
        let visual = byId.get(enemy.id);
        if (!visual) {
          visual = visuals.find((candidate) => !candidate.root.visible && candidate.type === enemy.type);
          if (!visual) return;
          visual.root.visible = true; visual.stateId = enemy.id; byId.set(enemy.id, visual);
        }
        const insideLift = enemy.stage === 'inside' ? (enemy.type === 'clinger' ? .72 : enemy.type === 'leeche' ? .48 : 0) : 0;
        visual.root.position.lerp(new THREE.Vector3(enemy.position.x, enemy.position.y + insideLift, enemy.position.z), 1 - Math.exp(-dt * 14));
        visual.root.rotation.y = THREE.MathUtils.lerp(visual.root.rotation.y, enemy.stage === 'attached' || enemy.stage === 'breaching' ? enemy.side * Math.PI * .5 : 0, 1 - Math.exp(-dt * 8));
        const attacking = enemy.stage === 'breaching' || enemy.stage === 'inside';
        const action = enemy.type === 'ripper' ? (attacking ? 'alarm' : 'walk') : (attacking ? 'attack' : 'prowl');
        setAction(visual, action, .1);
        visual.mixer.update(dt * (enemy.type === 'clinger' ? 1.55 : enemy.type === 'ripper' ? .82 : 1.1));
        if (enemy.type === 'leeche') visual.root.rotation.z = Math.sin(elapsed * 3 + enemy.id) * .12;
        const maxHealth = enemy.type === 'ripper' ? 145 : enemy.type === 'leeche' ? 78 : 62;
        const hurt = THREE.MathUtils.clamp(enemy.health / maxHealth, .7, 1);
        visual.root.scale.setScalar((enemy.type === 'ripper' ? .98 : 1) * hurt);
      });
    },
    dispose() {
      prototypes.forEach((prototype) => {
        prototype.skin.geometry.dispose();
        prototype.ownedMaterials.forEach((material) => material.dispose());
      });
    },
  };
}

export function createCrewRig(materials: TrainMaterials): CrewRig {
  const root = new THREE.Group(); root.name = 'passenger-crew';
  const colors = ['#394c52', '#5b3940', '#5d5432'];
  const actors = colors.map((color, index) => {
    const coat = materials.leather.clone();
    coat.color.set(color); coat.roughness = .68;
    const individualScale = index === 2 ? 1.04 : index === 1 ? .94 : 1;
    const actor = createHuman(materials, coat, individualScale * 0.84, [coat]);
    actor.root.position.set(index === 1 ? -2.1 : index === 2 ? 2.1 : 1.95, 0, 4.8 + index * 4.05);
    actor.root.rotation.y = index === 1 ? -.35 : index === 2 ? .42 : Math.PI;
    root.add(actor.root);
    return actor;
  });
  return {
    root,
    update(state, dt, elapsed, camera, focus) {
      actors.forEach((actor, index) => {
        const passenger = state.passengers[index];
        actor.root.visible = Boolean(passenger && passenger.health > 0);
        if (!passenger) return;
        // Oren lays the assisted sight from the offset loader's stool rather
        // than occupying the exact same control volume as the player gunner.
        const turretOffsetX = passenger.activity === 'turret' ? .78 : 0;
        const turretOffsetZ = passenger.activity === 'turret' ? -.34 : 0;
        const target = new THREE.Vector3(
          passenger.position.x + turretOffsetX,
          passenger.position.y,
          passenger.position.z + turretOffsetZ,
        );
        const delta = target.clone().sub(actor.root.position);
        actor.root.position.lerp(target, 1 - Math.exp(-dt * 7.5));
        if (delta.lengthSq() > .015) {
          const targetYaw = Math.atan2(-delta.x, -delta.z);
          actor.root.rotation.y = THREE.MathUtils.lerp(actor.root.rotation.y, targetYaw, 1 - Math.exp(-dt * 8));
        } else if (passenger.activity === 'turret') {
          actor.root.rotation.y = THREE.MathUtils.lerp(actor.root.rotation.y, Math.PI + state.turretYaw, 1 - Math.exp(-dt * 8));
        }
        const actionName = passenger.activity === 'moving' ? 'walk'
          : passenger.activity === 'repairing' || passenger.activity === 'medical' ? 'work'
          : passenger.activity === 'turret' ? 'aim'
          : passenger.activity === 'sheltering' ? 'shelter'
          : state.alarm ? 'alarm' : 'idle';
        setAction(actor, actionName, .2);
        const active = actor.actions.get(actor.activeAction);
        if (active) active.timeScale = passenger.activity === 'moving' ? 1.05 : state.alarm ? 1.1 + index * .12 : .78 + index * .08;
        actor.mixer.update(dt);
        actor.root.position.y = passenger.position.y + Math.sin(elapsed * .7 + index) * .006;
        if (camera && focus && actor.root.visible) {
          const sight = focus.clone().sub(camera);
          const sightDistance = sight.length();
          if (sightDistance > .01) {
            sight.multiplyScalar(1 / sightDistance);
            const toCrew = actor.root.position.clone().add(new THREE.Vector3(0, 1.05, 0)).sub(camera);
            const alongSight = toCrew.dot(sight);
            const laneDistance = toCrew.addScaledVector(sight, -alongSight).length();
            const nearCamera = actor.root.position.distanceTo(camera) < 3.25;
            const blocksSight = alongSight > 0 && alongSight < sightDistance && laneDistance < (state.player.aiming ? 1.2 : .82);
            if (nearCamera || blocksSight) actor.root.visible = false;
          }
        }
      });
    },
    dispose() {
      actors.forEach((actor) => {
        actor.skin.geometry.dispose();
        actor.ownedMaterials.forEach((material) => material.dispose());
      });
    },
  };
}
