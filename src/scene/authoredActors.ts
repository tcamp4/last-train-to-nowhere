import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { EnemyState, EnemyType, GameState } from '../shared/types';

interface AnimatedAsset {
  wrapper: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  activeAction: string;
}

interface AuthoredPlayer extends AnimatedAsset {
  hand: THREE.Object3D | undefined;
  weapon: THREE.Group;
  muzzle: THREE.Object3D;
  lastPosition: THREE.Vector3;
  animationRoot: THREE.Object3D;
  visibleSkeleton: THREE.SkinnedMesh;
  floorBones: THREE.Object3D[];
  lastShotSequence: number;
  boneLinks: Array<{
    target: THREE.Bone;
    source: THREE.Bone;
    targetRest: THREE.Quaternion;
    sourceRest: THREE.Quaternion;
  }>;
}

interface AuthoredEnemy extends AnimatedAsset {
  type: EnemyType;
  stateId: number;
  materials: THREE.MeshStandardMaterial[];
}

export interface AuthoredActorsRig {
  root: THREE.Group;
  readonly playerReady: boolean;
  readonly enemiesReady: boolean;
  update(state: GameState, dt: number, elapsed: number, aimTarget: THREE.Vector3, bodyVisible: boolean): void;
  getPlayerMuzzle(target: THREE.Vector3): boolean;
  dispose(): void;
}

const loader = new GLTFLoader();
const forward = new THREE.Vector3(0, 0, -1);
const worldPosition = new THREE.Vector3();
const aimDirection = new THREE.Vector3();
const worldQuaternion = new THREE.Quaternion();
const parentQuaternion = new THREE.Quaternion();
const animationDelta = new THREE.Quaternion();
const PLAYER_BALL_HEIGHT = 0.15;

const PLAYER_ACTIONS = [
  'Idle_Loop',
  'Jog_Fwd_Loop',
  'Sprint_Loop',
  'Pistol_Aim_Down',
  'Pistol_Aim_Neutral',
  'Pistol_Aim_Up',
  'Pistol_Reload',
  'Pistol_Shoot',
  'Roll',
] as const;

// Female_Ranger uses the Quaternius modular-character skeleton while the
// animation library uses its DEF-* rig. Retarget only the bones represented in
// both rigs so the textured hero can use the library's locomotion and aim clips.
const PLAYER_BONE_MAP: Record<string, string> = {
  pelvis: 'DEF-hips',
  spine_01: 'DEF-spine.001',
  spine_02: 'DEF-spine.002',
  spine_03: 'DEF-spine.003',
  neck_01: 'DEF-neck',
  Head: 'DEF-head',
  clavicle_l: 'DEF-shoulder.L',
  upperarm_l: 'DEF-upper_arm.L',
  lowerarm_l: 'DEF-forearm.L',
  hand_l: 'DEF-hand.L',
  index_01_l: 'DEF-f_index.01.L',
  index_02_l: 'DEF-f_index.02.L',
  index_03_l: 'DEF-f_index.03.L',
  middle_01_l: 'DEF-f_middle.01.L',
  middle_02_l: 'DEF-f_middle.02.L',
  middle_03_l: 'DEF-f_middle.03.L',
  pinky_01_l: 'DEF-f_pinky.01.L',
  pinky_02_l: 'DEF-f_pinky.02.L',
  pinky_03_l: 'DEF-f_pinky.03.L',
  ring_01_l: 'DEF-f_ring.01.L',
  ring_02_l: 'DEF-f_ring.02.L',
  ring_03_l: 'DEF-f_ring.03.L',
  thumb_01_l: 'DEF-thumb.01.L',
  thumb_02_l: 'DEF-thumb.02.L',
  thumb_03_l: 'DEF-thumb.03.L',
  clavicle_r: 'DEF-shoulder.R',
  upperarm_r: 'DEF-upper_arm.R',
  lowerarm_r: 'DEF-forearm.R',
  hand_r: 'DEF-hand.R',
  index_01_r: 'DEF-f_index.01.R',
  index_02_r: 'DEF-f_index.02.R',
  index_03_r: 'DEF-f_index.03.R',
  middle_01_r: 'DEF-f_middle.01.R',
  middle_02_r: 'DEF-f_middle.02.R',
  middle_03_r: 'DEF-f_middle.03.R',
  pinky_01_r: 'DEF-f_pinky.01.R',
  pinky_02_r: 'DEF-f_pinky.02.R',
  pinky_03_r: 'DEF-f_pinky.03.R',
  ring_01_r: 'DEF-f_ring.01.R',
  ring_02_r: 'DEF-f_ring.02.R',
  ring_03_r: 'DEF-f_ring.03.R',
  thumb_01_r: 'DEF-thumb.01.R',
  thumb_02_r: 'DEF-thumb.02.R',
  thumb_03_r: 'DEF-thumb.03.R',
  thigh_l: 'DEF-thigh.L',
  calf_l: 'DEF-shin.L',
  foot_l: 'DEF-foot.L',
  ball_l: 'DEF-toe.L',
  thigh_r: 'DEF-thigh.R',
  calf_r: 'DEF-shin.R',
  foot_r: 'DEF-foot.R',
  ball_r: 'DEF-toe.R',
};

function normalizeModel(model: THREE.Object3D, targetHeight: number) {
  model.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const normalizer = new THREE.Group();
  model.position.set(-center.x, -bounds.min.y, -center.z);
  normalizer.scale.setScalar(targetHeight / Math.max(0.1, size.y));
  normalizer.add(model);
  return normalizer;
}

function prepareMeshes(root: THREE.Object3D, player = false) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = false;
    object.frustumCulled = false;
    if (!player) return;
    const source = object.material;
    const cloned = Array.isArray(source) ? source.map((material) => material.clone()) : source.clone();
    object.material = cloned;
    for (const material of Array.isArray(cloned) ? cloned : [cloned]) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      // Keep the authored albedo/normal/ORM maps visible. The previous flat
      // charcoal override is what made the library mannequin read as an empty
      // gray skin instead of a finished character.
      material.color.multiply(new THREE.Color('#c5bba8'));
      material.roughness = Math.max(0.58, material.roughness);
      material.metalness = Math.min(0.16, material.metalness);
      material.emissive.set('#020201');
      material.emissiveIntensity = 0.08;
    }
  });
}

function firstSkinnedMesh(root: THREE.Object3D) {
  let result: THREE.SkinnedMesh | undefined;
  root.traverse((object) => {
    if (!result && object instanceof THREE.SkinnedMesh) result = object;
  });
  return result;
}

function makeRetargetedPlayerActions(target: THREE.Object3D, animationSource: THREE.Object3D, clips: THREE.AnimationClip[]) {
  const targetMesh = firstSkinnedMesh(target);
  const sourceMesh = firstSkinnedMesh(animationSource);
  if (!targetMesh || !sourceMesh) throw new Error('Player retarget skeleton is missing');
  const selected = PLAYER_ACTIONS.map((name) => clips.find((clip) => clip.name === name)).filter((clip): clip is THREE.AnimationClip => Boolean(clip));
  targetMesh.skeleton.pose();
  sourceMesh.skeleton.pose();
  const boneLinks = Object.entries(PLAYER_BONE_MAP).flatMap(([targetName, sourceName]) => {
    const targetBone = targetMesh.skeleton.getBoneByName(targetName);
    const sourceBone = sourceMesh.skeleton.getBoneByName(THREE.PropertyBinding.sanitizeNodeName(sourceName));
    return targetBone && sourceBone ? [{
      target: targetBone,
      source: sourceBone,
      targetRest: targetBone.quaternion.clone(),
      sourceRest: sourceBone.quaternion.clone(),
    }] : [];
  });
  return { ...makeActions(animationSource, selected), targetMesh, boneLinks };
}

function styleEnemy(root: THREE.Object3D, type: EnemyType) {
  const tint = new THREE.Color(type === 'clinger' ? '#718489' : type === 'leeche' ? '#74815f' : '#805948');
  const materials: THREE.MeshStandardMaterial[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const source = object.material;
    const cloned = Array.isArray(source) ? source.map((material) => material.clone()) : source.clone();
    object.material = cloned;
    for (const material of Array.isArray(cloned) ? cloned : [cloned]) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      material.color.multiply(tint);
      material.roughness = 0.72;
      material.metalness = 0.08;
      materials.push(material);
    }
  });
  return materials;
}

function makeActions(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<string, THREE.AnimationAction>();
  clips.forEach((clip) => actions.set(clip.name, mixer.clipAction(clip)));
  return { mixer, actions };
}

function setAction(asset: AnimatedAsset, name: string, fade = 0.16, restart = false) {
  if (asset.activeAction === name && !restart) return;
  const next = asset.actions.get(name);
  if (!next) return;
  const previous = asset.actions.get(asset.activeAction);
  next.reset().fadeIn(fade).play();
  if (previous && previous !== next) previous.fadeOut(fade);
  asset.activeAction = name;
}

function pointNegativeZAt(object: THREE.Object3D, target: THREE.Vector3) {
  const parent = object.parent;
  if (!parent) return;
  parent.updateWorldMatrix(true, false);
  object.getWorldPosition(worldPosition);
  aimDirection.subVectors(target, worldPosition);
  if (aimDirection.lengthSq() < 0.001) return;
  aimDirection.normalize();
  worldQuaternion.setFromUnitVectors(forward, aimDirection);
  parent.getWorldQuaternion(parentQuaternion).invert();
  object.quaternion.copy(parentQuaternion.multiply(worldQuaternion));
}

function makeWeapon(model: THREE.Object3D) {
  prepareMeshes(model);
  model.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  model.position.sub(center);
  const holder = new THREE.Group();
  holder.rotation.y = Math.PI / 2;
  holder.scale.setScalar(0.46 / Math.max(0.01, size.x, size.y, size.z));
  holder.position.set(0, -0.035, -0.14);
  holder.add(model);
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const source = object.material;
    const cloned = Array.isArray(source) ? source.map((material) => material.clone()) : source.clone();
    object.material = cloned;
    for (const material of Array.isArray(cloned) ? cloned : [cloned]) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      material.color.multiplyScalar(0.18);
      material.roughness = 0.38;
      material.metalness = 0.78;
    }
  });
  const weapon = new THREE.Group();
  weapon.name = 'authored-k12-sidearm';
  weapon.add(holder);
  const muzzle = new THREE.Object3D();
  muzzle.name = 'authored-k12-muzzle';
  muzzle.position.set(0, 0, -0.39);
  weapon.add(muzzle);
  return { weapon, muzzle };
}

function enemyHeight(type: EnemyType) {
  if (type === 'ripper') return 2.18;
  if (type === 'leeche') return 1.02;
  return 1.55;
}

function enemyAction(type: EnemyType, attacking: boolean) {
  if (type === 'leeche') return attacking ? 'Headbutt' : 'Fast_Flying';
  return attacking ? 'Punch' : 'Run';
}

function createEnemyVisual(type: EnemyType, source: THREE.Object3D, clips: THREE.AnimationClip[]) {
  const wrapper = new THREE.Group();
  wrapper.name = `authored-${type}`;
  const model = cloneSkeleton(source) as THREE.Group;
  prepareMeshes(model);
  const materials = styleEnemy(model, type);
  wrapper.add(normalizeModel(model, enemyHeight(type)));
  const { mixer, actions } = makeActions(wrapper, clips);
  const initial = enemyAction(type, false);
  actions.get(initial)?.play();
  wrapper.visible = false;
  const death = actions.get('Death');
  if (death) {
    death.setLoop(THREE.LoopOnce, 1).setEffectiveTimeScale(1.35);
    death.clampWhenFinished = true;
  }
  const hitReact = actions.get('HitReact');
  if (hitReact) {
    hitReact.setLoop(THREE.LoopOnce, 1).setEffectiveTimeScale(1.8);
    hitReact.clampWhenFinished = true;
  }
  return { wrapper, mixer, actions, activeAction: initial, type, stateId: -1, materials } satisfies AuthoredEnemy;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => material.dispose());
  });
}

export function createAuthoredActors(): AuthoredActorsRig {
  const root = new THREE.Group();
  root.name = 'authored-gltf-actors';
  const enemyRoot = new THREE.Group();
  root.add(enemyRoot);
  let player: AuthoredPlayer | undefined;
  let enemiesReady = false;
  let disposed = false;
  const enemyVisuals: AuthoredEnemy[] = [];
  const enemiesById = new Map<number, AuthoredEnemy>();

  void Promise.all([
    loader.loadAsync('/assets/actors/Female_Ranger.gltf'),
    loader.loadAsync('/assets/actors/player-engineer.gltf'),
    loader.loadAsync('/assets/weapons/k12-sidearm.glb'),
  ]).then(([character, animationLibrary, weaponAsset]) => {
    if (disposed) return;
    const wrapper = new THREE.Group();
    wrapper.name = 'authored-player-engineer';
    prepareMeshes(character.scene, true);
    const model = normalizeModel(character.scene, 1.88);
    model.name = 'authored-player-textured-model';
    // The modular ranger was authored facing +Z. Gameplay yaw 0 and the orbit
    // camera both define forward as -Z, so correct the import axis once here.
    model.rotation.y = Math.PI;
    wrapper.add(model);
    const { mixer, actions, targetMesh, boneLinks } = makeRetargetedPlayerActions(character.scene, animationLibrary.scene, animationLibrary.animations);
    const initial = 'Pistol_Aim_Neutral';
    actions.get(initial)?.play();
    const shoot = actions.get('Pistol_Shoot');
    if (shoot) {
      shoot.setLoop(THREE.LoopOnce, 1).setEffectiveTimeScale(1.8);
      shoot.clampWhenFinished = true;
    }
    const reload = actions.get('Pistol_Reload');
    if (reload) {
      reload.setLoop(THREE.LoopOnce, 1).setEffectiveTimeScale(1.1);
      reload.clampWhenFinished = true;
    }
    const roll = actions.get('Roll');
    if (roll) {
      roll.setLoop(THREE.LoopOnce, 1).setEffectiveTimeScale(1.35);
      roll.clampWhenFinished = true;
    }
    const { weapon, muzzle } = makeWeapon(weaponAsset.scene);
    root.add(wrapper, weapon);
    player = {
      wrapper,
      mixer,
      actions,
      activeAction: initial,
      hand: wrapper.getObjectByName('hand_r'),
      weapon,
      muzzle,
      lastPosition: new THREE.Vector3(),
      animationRoot: animationLibrary.scene,
      visibleSkeleton: targetMesh,
      floorBones: ['ball_l', 'ball_r'].map((name) => wrapper.getObjectByName(name)).filter((bone): bone is THREE.Object3D => Boolean(bone)),
      lastShotSequence: 0,
      boneLinks,
    };
  }).catch((error: unknown) => console.warn('Authored player asset fallback active:', error));

  const enemyFiles: Record<EnemyType, string> = {
    clinger: '/assets/actors/clinger.gltf',
    leeche: '/assets/actors/leeche.gltf',
    ripper: '/assets/actors/ripper.gltf',
  };
  void Promise.all((Object.entries(enemyFiles) as [EnemyType, string][]).map(async ([type, file]) => ({ type, gltf: await loader.loadAsync(file) })))
    .then((loaded) => {
      if (disposed) return;
      loaded.forEach(({ type, gltf }) => {
        for (let index = 0; index < 6; index += 1) {
          const visual = createEnemyVisual(type, gltf.scene, gltf.animations);
          enemyVisuals.push(visual);
          enemyRoot.add(visual.wrapper);
        }
      });
      enemiesReady = true;
    })
    .catch((error: unknown) => console.warn('Authored enemy asset fallback active:', error));

  return {
    root,
    get playerReady() { return Boolean(player); },
    get enemiesReady() { return enemiesReady; },
    update(state, dt, elapsed, aimTarget, bodyVisible) {
      if (player) {
        const playerPosition = state.player.position;
        player.wrapper.position.set(playerPosition.x, playerPosition.y, playerPosition.z);
        player.wrapper.rotation.y = state.player.yaw;
        const speed = state.player.moveSpeed;
        const firearm = state.player.equipment !== 'wrench';
        const firedThisFrame = state.player.shotSequence !== player.lastShotSequence;
        const aimAction = state.player.aimPitch > 0.11
          ? 'Pistol_Aim_Up'
          : state.player.aimPitch < -0.11
            ? 'Pistol_Aim_Down'
            : 'Pistol_Aim_Neutral';
        const action = state.player.dodging
          ? 'Roll'
          : state.player.reloading
            ? 'Pistol_Reload'
          : firearm && (firedThisFrame || state.player.recoil > 0.08)
            ? 'Pistol_Shoot'
            : firearm && (state.player.aiming || speed < 0.18)
              ? aimAction
              : speed > 5.25
                ? 'Sprint_Loop'
                : speed > 0.18
                  ? 'Jog_Fwd_Loop'
                  : 'Idle_Loop';
        setAction(player, action, state.player.dodging || firedThisFrame ? 0.045 : 0.13, firedThisFrame);
        player.lastShotSequence = state.player.shotSequence;
        const locomotion = player.actions.get(action);
        if (locomotion && (action === 'Jog_Fwd_Loop' || action === 'Sprint_Loop')) {
          locomotion.timeScale = THREE.MathUtils.clamp(speed / (action === 'Sprint_Loop' ? 6.7 : 4.4), 0.72, 1.28);
        }
        player.mixer.update(dt);
        player.visibleSkeleton.skeleton.pose();
        player.boneLinks.forEach((link) => {
          // Transfer animation in each joint's local frame. Applying the
          // source delta to the ranger's own bind quaternion preserves her
          // proportions and never lets an animation clip flip the model root.
          animationDelta.copy(link.sourceRest).invert().multiply(link.source.quaternion);
          link.target.quaternion.copy(link.targetRest).multiply(animationDelta);
        });
        // The modular boots extend below their toe bones. Ground the animated
        // rig from the lowest planted toe each frame so no gait clip can sink
        // the visible soles through the aisle while gameplay stays on Y=0.
        player.wrapper.updateWorldMatrix(true, true);
        const lowestToe = player.floorBones.reduce(
          (lowest, bone) => Math.min(lowest, bone.matrixWorld.elements[13]),
          Number.POSITIVE_INFINITY,
        );
        if (Number.isFinite(lowestToe)) {
          player.wrapper.position.y += THREE.MathUtils.clamp(
            playerPosition.y + PLAYER_BALL_HEIGHT - lowestToe,
            0,
            0.28,
          );
          player.wrapper.updateWorldMatrix(true, true);
        }
        player.wrapper.visible = !state.mountedTurretActive && bodyVisible;
        player.weapon.visible = !state.mountedTurretActive && firearm && bodyVisible;
        if (player.weapon.visible) {
          player.wrapper.updateWorldMatrix(true, true);
          if (player.hand) player.hand.getWorldPosition(player.weapon.position);
          else player.weapon.position.set(playerPosition.x + 0.35, playerPosition.y + 1.25, playerPosition.z - 0.3);
          pointNegativeZAt(player.weapon, aimTarget);
          player.weapon.updateWorldMatrix(true, true);
        }
        player.lastPosition.copy(player.wrapper.position);
      }

      if (!enemiesReady) return;
      const activeEnemies = state.enemies.filter((enemy) => enemy.stage !== 'dead' || enemy.timer < 0.68);
      const activeIds = new Set(activeEnemies.map((enemy) => enemy.id));
      enemiesById.forEach((visual, id) => {
        if (activeIds.has(id)) return;
        visual.wrapper.visible = false;
        visual.stateId = -1;
        enemiesById.delete(id);
      });
      activeEnemies.forEach((enemy: EnemyState) => {
        let visual = enemiesById.get(enemy.id);
        if (!visual) {
          visual = enemyVisuals.find((candidate) => candidate.stateId < 0 && candidate.type === enemy.type);
          if (!visual) return;
          visual.stateId = enemy.id;
          visual.wrapper.visible = true;
          visual.wrapper.position.set(enemy.position.x, enemy.position.y, enemy.position.z);
          enemiesById.set(enemy.id, visual);
        }
        const airborne = enemy.type === 'leeche' ? 0.62 + Math.sin(elapsed * 3 + enemy.id) * 0.08 : 0;
        const deathDrop = enemy.stage === 'dead' ? Math.min(0.24, enemy.timer * 0.4) : 0;
        const target = new THREE.Vector3(enemy.position.x, enemy.position.y + airborne - deathDrop, enemy.position.z);
        visual.wrapper.position.lerp(target, 1 - Math.exp(-dt * 14));
        const targetYaw = enemy.stage === 'attached' || enemy.stage === 'breaching' ? enemy.side * Math.PI * 0.5 : 0;
        visual.wrapper.rotation.y = THREE.MathUtils.lerp(visual.wrapper.rotation.y, targetYaw, 1 - Math.exp(-dt * 8));
        const attacking = enemy.stage === 'breaching' || enemy.stage === 'inside';
        const action = enemy.stage === 'dead'
          ? 'Death'
          : enemy.hitStun > 0
            ? 'HitReact'
            : enemyAction(enemy.type, attacking);
        setAction(visual, action, enemy.hitStun > 0 || enemy.stage === 'dead' ? 0.045 : 0.1);
        visual.mixer.update(dt * (enemy.type === 'ripper' ? 0.82 : 1.15));
        visual.wrapper.scale.setScalar(1);
        const flash = enemy.hitStun > 0 ? enemy.hitStun / 0.2 : 0;
        visual.materials.forEach((material) => {
          material.emissive.set(enemy.type === 'leeche' ? '#9deed8' : '#ff6e45');
          material.emissiveIntensity = flash * 1.8;
        });
      });
    },
    getPlayerMuzzle(target) {
      if (!player?.weapon.visible) return false;
      player.muzzle.getWorldPosition(target);
      return true;
    },
    dispose() {
      disposed = true;
      disposeObject(root);
      if (player) disposeObject(player.animationRoot);
      player?.mixer.stopAllAction();
      enemyVisuals.forEach((visual) => visual.mixer.stopAllAction());
    },
  };
}
