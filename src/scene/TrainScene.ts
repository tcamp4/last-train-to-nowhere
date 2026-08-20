import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GameState, GameplayEvents, QualitySettings, Vec3Data } from '../shared/types';
import { createCrewRig, createPlayer, createEnemyRig, type CrewRig, type EnemyRig, type PlayerRig } from './actors';
import { createAuthoredActors, type AuthoredActorsRig } from './authoredActors';
import { createEffects, type EffectsRig } from './effects';
import { createWorld, type WorldRig } from './environment';
import { createTrainMaterials, makeMesh, roundedBox, type TrainMaterials } from './materials';
import { createTrain, type TrainRig } from './train';

export const QUALITY_PRESETS: Record<QualitySettings['preset'], QualitySettings> = {
  low: { preset: 'low', shadows: false, particles: 260, resolutionScale: 0.72 },
  medium: { preset: 'medium', shadows: true, particles: 520, resolutionScale: 0.86 },
  high: { preset: 'high', shadows: true, particles: 900, resolutionScale: 1 },
  ultra: { preset: 'ultra', shadows: true, particles: 1400, resolutionScale: 1 },
};

const CAMERA_PITCH_MIN = -0.32;
const CAMERA_PITCH_MAX = 0.32;
const READY_CAMERA_DISTANCE = 4.65;
const READY_SHOULDER_OFFSET = 1.62;
const READY_FOCUS_DISTANCE = 7;
const AIM_CAMERA_DISTANCE = 4.15;
const AIM_SHOULDER_OFFSET = 1.68;
const AIM_FOCUS_DISTANCE = 7.5;
const BODY_HIDE_DISTANCE = 3.05;

function resolveQuality(value: QualitySettings | QualitySettings['preset'] | undefined): QualitySettings {
  return typeof value === 'string' ? { ...QUALITY_PRESETS[value] } : value ? { ...value } : { ...QUALITY_PRESETS.high };
}

function makeSky() {
  const geometry = new THREE.SphereGeometry(270, 40, 24);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color('#131b22') },
      uHorizon: { value: new THREE.Color('#695744') },
      uStorm: { value: 0.3 },
    },
    vertexShader: 'varying vec3 vWorld; void main(){ vec4 w=modelMatrix*vec4(position,1.); vWorld=w.xyz; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `
      varying vec3 vWorld;
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform float uStorm;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      void main(){
        float h=clamp(normalize(vWorld).y*.72+.38,0.,1.);
        float cloud=smoothstep(.38,.72,hash(floor(normalize(vWorld).xz*36.))*.32+sin(vWorld.x*.021+vWorld.z*.016)*.34+.38);
        vec3 c=mix(uHorizon,uTop,smoothstep(.08,.78,h));
        c=mix(c,c*.46,cloud*uStorm);
        gl_FragColor=vec4(c,1.);
      }
    `,
  });
  return new THREE.Mesh(geometry, material);
}

function makeNavigationMarker() {
  const root = new THREE.Group();
  root.name = 'system-navigation-marker';
  root.visible = false;
  const material = new THREE.MeshBasicMaterial({
    color: '#e5b34f',
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const faint = material.clone();
  faint.opacity = 0.24;
  const diamond = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0), material);
  diamond.name = 'navigation-diamond';
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.016, 6, 24), material);
  ring.name = 'navigation-ring';
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.27;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.72, 5), faint);
  stem.position.y = -0.66;
  root.userData.materials = [material, faint];
  root.userData.urgent = false;
  root.add(diamond, ring, stem);
  root.traverse((object) => { object.renderOrder = 30; });
  return root;
}

function buildStation(materials: TrainMaterials) {
  const root = new THREE.Group();
  root.name = 'cinder-crossing-station';
  root.position.set(11.5, -1.05, 2);
  const platform = makeMesh(roundedBox(10.8, 1.0, 72, 0.25, 4), materials.steel);
  platform.receiveShadow = true;
  root.add(platform);
  for (let z = -30; z <= 30; z += 6) {
    const column = makeMesh(new THREE.CylinderGeometry(0.22, 0.3, 6.8, 18), materials.brass);
    column.position.set(2.8, 3.65, z);
    root.add(column);
    const truss = makeMesh(new THREE.TorusGeometry(3.8, 0.11, 7, 28, Math.PI), materials.darkSteel);
    truss.position.set(-0.8, 6.5, z);
    truss.rotation.z = Math.PI / 2;
    root.add(truss);
    const lamp = makeMesh(new THREE.SphereGeometry(0.17, 16, 10), materials.lamp);
    lamp.position.set(-0.7, 5.6, z);
    root.add(lamp);
  }
  const booth = new THREE.Group();
  const boothBody = makeMesh(roundedBox(5.4, 4.4, 8.2, 0.36, 5), materials.armor);
  boothBody.position.y = 2.6;
  booth.add(boothBody);
  for (const z of [-2.4, 0, 2.4]) {
    const glass = makeMesh(roundedBox(0.14, 1.5, 1.5, 0.15, 4), materials.glass);
    glass.position.set(-2.77, 3.05, z);
    booth.add(glass);
  }
  booth.position.set(3.2, 0.4, -16);
  root.add(booth);
  for (const z of [12, 19, 26]) {
    const tank = makeMesh(new THREE.CapsuleGeometry(1.2, 2.9, 8, 22), materials.darkSteel);
    tank.position.set(3.1, 2.3, z);
    root.add(tank);
    for (const y of [1.1, 3.5]) {
      const band = makeMesh(new THREE.TorusGeometry(1.23, 0.08, 8, 24), materials.brass);
      band.rotation.x = Math.PI / 2;
      band.position.set(3.1, y, z);
      root.add(band);
    }
  }
  const sign = makeMesh(roundedBox(0.32, 1.2, 7.5, 0.16, 4), materials.darkSteel);
  sign.position.set(-1.2, 5, -6);
  root.add(sign);
  return root;
}

export class TrainScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(64, 1, 0.06, 360);
  readonly renderer: THREE.WebGLRenderer;
  readonly train: TrainRig;
  readonly player: PlayerRig;
  readonly authoredActors: AuthoredActorsRig;
  readonly crew: CrewRig;
  readonly enemies: EnemyRig;
  readonly world: WorldRig;
  readonly effects: EffectsRig;

  private materials: TrainMaterials;
  private quality: QualitySettings;
  private cameraYaw = 0;
  private cameraPitch = 0;
  private currentFocus = new THREE.Vector3();
  private currentCamera = new THREE.Vector3(0, 3, 5);
  private raycaster = new THREE.Raycaster();
  private cameraDirection = new THREE.Vector3();
  private desiredCamera = new THREE.Vector3();
  private cameraInitialized = false;
  private currentFov = 64;
  private currentShoulder = READY_SHOULDER_OFFSET;
  private handheldSightlineLastFrame = false;
  private playerCameraDistance = Number.POSITIVE_INFINITY;
  private turretMuzzlePosition = new THREE.Vector3();
  private playerMuzzlePosition = new THREE.Vector3();
  private navigationMarker: THREE.Group;
  private interiorLights: THREE.PointLight[] = [];
  private headlight: THREE.SpotLight;
  private moonLight: THREE.DirectionalLight;
  private lightning: THREE.PointLight;
  private station: THREE.Group;
  private sky: THREE.Mesh;
  private dealReactor?: THREE.Group;
  private width = 1;
  private height = 1;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, quality?: QualitySettings | QualitySettings['preset']) {
    this.quality = resolveQuality(quality);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.quality.preset !== 'low', powerPreference: 'high-performance', alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor('#13191b', 1);

    this.scene.fog = new THREE.FogExp2('#5c5145', 0.0115);
    this.materials = createTrainMaterials(this.renderer.capabilities.getMaxAnisotropy());
    this.train = createTrain(this.materials);
    this.train.root.traverse((object) => {
      if (object instanceof THREE.Mesh) object.layers.enable(2);
    });
    this.player = createPlayer(this.materials);
    this.authoredActors = createAuthoredActors();
    this.crew = createCrewRig(this.materials);
    this.enemies = createEnemyRig(this.materials);
    this.world = createWorld(this.materials, this.quality);
    this.effects = createEffects(this.materials);
    this.navigationMarker = makeNavigationMarker();
    this.scene.add(this.world.root, this.train.root, this.player.root, this.authoredActors.root, this.crew.root, this.enemies.root, this.effects.root, this.navigationMarker);
    this.raycaster.layers.set(2);
    new GLTFLoader().load('/assets/black-canister-reactor.gltf', (gltf) => {
      if (this.disposed) return;
      this.dealReactor = gltf.scene;
      this.dealReactor.name = 'loaded-original-black-canister-reactor';
      this.dealReactor.position.set(-2.05, 0.18, -6.7);
      this.dealReactor.rotation.y = Math.PI / 2;
      this.dealReactor.scale.setScalar(0.82);
      this.dealReactor.visible = false;
      this.dealReactor.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = true;
          object.receiveShadow = true;
          object.layers.enable(2);
        }
      });
      this.train.root.add(this.dealReactor);
    });

    this.sky = makeSky();
    this.scene.add(this.sky);
    this.station = buildStation(this.materials);
    this.station.visible = false;
    this.scene.add(this.station);

    const hemisphere = new THREE.HemisphereLight('#a6b6cb', '#73482b', 2.35);
    this.scene.add(hemisphere);
    this.moonLight = new THREE.DirectionalLight('#9ebde1', 2.35);
    this.moonLight.position.set(-44, 65, 20);
    this.moonLight.castShadow = this.quality.shadows;
    this.moonLight.shadow.mapSize.set(this.quality.preset === 'ultra' ? 2048 : 1024, this.quality.preset === 'ultra' ? 2048 : 1024);
    this.moonLight.shadow.camera.left = -46;
    this.moonLight.shadow.camera.right = 46;
    this.moonLight.shadow.camera.top = 70;
    this.moonLight.shadow.camera.bottom = -70;
    this.moonLight.shadow.camera.far = 160;
    this.moonLight.shadow.bias = -0.00012;
    this.scene.add(this.moonLight);

    for (let z = -32; z <= 32; z += 8) {
      const light = new THREE.PointLight('#ffbd70', 48, 12, 1.55);
      light.position.set(0, 3.72, z);
      light.castShadow = false;
      this.interiorLights.push(light);
      this.scene.add(light);
    }
    this.headlight = new THREE.SpotLight('#d8e9dd', 165, 135, Math.PI / 8, 0.38, 1.1);
    this.headlight.position.set(0, 4.25, -36);
    this.headlight.target.position.set(0, 0.2, -125);
    this.headlight.castShadow = this.quality.shadows;
    this.headlight.shadow.mapSize.set(1024, 1024);
    this.scene.add(this.headlight, this.headlight.target);
    this.lightning = new THREE.PointLight('#dce9ff', 0, 180, 1);
    this.lightning.position.set(25, 55, -60);
    this.scene.add(this.lightning);
    this.setQuality(this.quality);
  }

  rotateCamera(deltaX: number, deltaY: number) {
    this.cameraYaw -= deltaX * 0.00235;
    this.cameraPitch = THREE.MathUtils.clamp(
      this.cameraPitch - deltaY * 0.0019,
      CAMERA_PITCH_MIN,
      CAMERA_PITCH_MAX,
    );
  }

  setCameraRotation(yaw: number, pitch: number) {
    this.cameraYaw = yaw;
    this.cameraPitch = THREE.MathUtils.clamp(pitch, CAMERA_PITCH_MIN, CAMERA_PITCH_MAX);
  }

  getCameraRotation() {
    return { yaw: this.cameraYaw, pitch: this.cameraPitch };
  }

  setNavigationTarget(position?: Vec3Data, urgent = false) {
    this.navigationMarker.visible = Boolean(position);
    if (!position) return;
    this.navigationMarker.position.set(position.x, 2.05, position.z);
    this.navigationMarker.userData.urgent = urgent;
    const color = urgent ? '#ff6248' : '#e5b34f';
    (this.navigationMarker.userData.materials as THREE.MeshBasicMaterial[]).forEach((material) => material.color.set(color));
  }

  setQuality(value: QualitySettings | QualitySettings['preset']) {
    this.quality = resolveQuality(value);
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * this.quality.resolutionScale);
    this.renderer.setSize(this.width, this.height, false);
    this.moonLight.castShadow = this.quality.shadows;
    this.headlight.castShadow = this.quality.shadows && this.quality.preset !== 'low';
    const shadowSize = this.quality.preset === 'ultra' ? 2048 : 1024;
    this.moonLight.shadow.mapSize.set(shadowSize, shadowSize);
    this.world.setQuality(this.quality);
    this.effects.setParticleBudget(this.quality.particles);
  }

  resize(width = window.innerWidth, height = window.innerHeight, devicePixelRatio = window.devicePixelRatio || 1) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * this.quality.resolutionScale);
    this.renderer.setSize(this.width, this.height, false);
  }

  private updateCamera(state: GameState, dt: number, elapsed: number) {
    const player = this.player.root.position;
    const mounted = state.mountedTurretActive;
    const handheldAiming = state.player.aiming && !mounted;
    // A drawn firearm always uses an open over-the-shoulder sightline. RMB
    // tightens that same composition instead of switching from a centered
    // traversal camera whose reticle sits on the engineer's backpack.
    const handheldSightline = !mounted && state.player.equipment !== 'wrench';
    const handheldFocusDistance = handheldAiming ? AIM_FOCUS_DISTANCE : READY_FOCUS_DISTANCE;
    const aimX = Math.sin(state.turretYaw);
    const aimZ = Math.cos(state.turretYaw);
    const yaw = mounted ? Math.PI + state.turretYaw : this.cameraYaw;
    const pitch = mounted ? 0 : this.cameraPitch + state.player.recoil * 0.032;
    const pitchCos = Math.cos(pitch);
    const pitchSin = Math.sin(pitch);
    const playerAnchor = new THREE.Vector3(player.x, player.y + 1.65, player.z);
    const focus = mounted
      ? new THREE.Vector3(aimX * 3.5, 5.38, 31.7 + aimZ * 3.5)
      : handheldSightline
        ? new THREE.Vector3(
            playerAnchor.x - Math.sin(yaw) * pitchCos * handheldFocusDistance,
            playerAnchor.y + pitchSin * handheldFocusDistance,
            playerAnchor.z - Math.cos(yaw) * pitchCos * handheldFocusDistance,
          )
        : playerAnchor.clone();
    // Snap onto the downrange sightline when a firearm is drawn. A slow blend
    // starts at the backpack and visibly drags the reticle through the avatar.
    if (!this.cameraInitialized || (handheldSightline && !this.handheldSightlineLastFrame)) {
      this.currentFocus.copy(focus);
    } else {
      this.currentFocus.lerp(focus, 1 - Math.exp(-dt * (handheldSightline ? 24 : 13)));
    }
    this.handheldSightlineLastFrame = handheldSightline;
    // Gameplay and presentation both consume the same mouse delta: gameplay owns
    // facing/movement yaw while this orbit yaw owns the over-shoulder viewpoint.
    const distance = mounted ? 5.15 : handheldAiming ? AIM_CAMERA_DISTANCE : handheldSightline ? READY_CAMERA_DISTANCE : 4.7;
    const horizontal = mounted ? Math.cos(-.075) * distance : handheldSightline ? distance : Math.cos(pitch * .7) * distance;
    const velocity = state.player.velocity;
    const localStrafe = Math.cos(yaw) * velocity.x - Math.sin(yaw) * velocity.z;
    const shoulderBase = mounted ? .42 : handheldAiming ? AIM_SHOULDER_OFFSET : handheldSightline ? READY_SHOULDER_OFFSET : .62;
    // In the narrow aisle a fixed right-shoulder camera can be crushed between
    // the player and the starboard wall. Switch across the body toward the open
    // aisle, with a spring so the composition never pops.
    const shoulderSide = !mounted && player.x > 0.48 ? -1 : 1;
    const targetShoulder = shoulderBase * shoulderSide - THREE.MathUtils.clamp(localStrafe * 0.028, -0.12, 0.12);
    this.currentShoulder = THREE.MathUtils.lerp(this.currentShoulder, targetShoulder, 1 - Math.exp(-dt * 8));
    const shoulder = this.currentShoulder;
    const locomotionBob = !mounted && state.player.moveSpeed > 0.35
      ? Math.sin(elapsed * (state.player.sprinting ? 13.5 : 10.5)) * (state.player.sprinting ? 0.032 : 0.018)
      : 0;
    // Aiming looks downrange, but the camera remains anchored to the player;
    // deriving its position from the distant focus would place it in front of
    // the engineer and put the avatar directly under the crosshair.
    const cameraAnchor = mounted ? this.currentFocus : playerAnchor;
    this.desiredCamera.set(
      cameraAnchor.x + Math.sin(yaw) * horizontal + Math.cos(yaw) * shoulder,
      mounted
        ? cameraAnchor.y + 0.42 + Math.sin(-.075) * distance
        : handheldSightline
          ? cameraAnchor.y + 0.32 - pitchSin * 0.5 + locomotionBob
          : cameraAnchor.y + 0.42 - pitchSin * Math.min(1.55, distance * .5),
      cameraAnchor.z + Math.cos(yaw) * horizontal - Math.sin(yaw) * shoulder,
    );
    this.cameraDirection.subVectors(this.desiredCamera, cameraAnchor);
    const desiredDistance = this.cameraDirection.length();
    this.cameraDirection.normalize();
    this.raycaster.set(cameraAnchor, this.cameraDirection);
    this.raycaster.near = 0.12;
    this.raycaster.far = desiredDistance;
    const collisions = this.raycaster.intersectObject(this.train.root, true).filter((hit) => hit.distance > 0.12);
    if (collisions.length > 0) {
      const collision = collisions[0];
      const available = collision.distance - 0.3;
      if (available >= 1.35) {
        this.desiredCamera.copy(cameraAnchor).addScaledVector(this.cameraDirection, available);
      } else {
        // At a wall the camera slides along the closed hull instead of escaping
        // through a window or crushing into the player's shoulders.
        const normal = collision.face?.normal.clone().transformDirection((collision.object as THREE.Mesh).matrixWorld) ?? new THREE.Vector3(-Math.sign(this.cameraDirection.x), 0, 0);
        const tangent = this.cameraDirection.clone().addScaledVector(normal, -this.cameraDirection.dot(normal));
        if (tangent.lengthSq() < 0.05) tangent.set(0, 0, Math.cos(yaw) >= 0 ? 1 : -1);
        tangent.normalize();
        this.desiredCamera.copy(cameraAnchor).addScaledVector(tangent, 1.55).addScaledVector(normal, 0.18);
      }
    }
    const shake = state.shake * 0.055;
    this.desiredCamera.x += Math.sin(elapsed * 51.2) * shake;
    this.desiredCamera.y += Math.sin(elapsed * 63.7) * shake * 0.55;
    this.desiredCamera.z += Math.cos(elapsed * 47.3) * shake;
    const targetFov = mounted ? 58 : state.player.dodging ? 72 : state.player.sprinting ? 68 : handheldAiming ? 57 : 63;
    this.currentFov = THREE.MathUtils.lerp(this.currentFov, targetFov, 1 - Math.exp(-dt * (handheldAiming ? 16 : 9)));
    if (Math.abs(this.camera.fov - this.currentFov) > 0.015) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }
    const trainLean = Math.sin(elapsed * 1.18) * 0.006 + Math.sin(elapsed * 8.1) * Math.min(0.008, state.speed * 0.00012);
    const movementLean = !mounted ? THREE.MathUtils.clamp(-localStrafe * 0.0045, -0.018, 0.018) : 0;
    const dodgeLean = state.player.dodging ? THREE.MathUtils.clamp(-localStrafe * 0.012, -0.055, 0.055) : 0;
    const lean = trainLean + movementLean + dodgeLean;
    if (!this.cameraInitialized) {
      this.currentCamera.copy(this.desiredCamera);
      this.cameraInitialized = true;
    } else {
      this.currentCamera.lerp(this.desiredCamera, 1 - Math.exp(-dt * (state.player.aiming ? 21 : state.player.dodging ? 18 : 12)));
    }
    this.camera.position.copy(this.currentCamera);
    this.playerCameraDistance = this.currentCamera.distanceTo(playerAnchor);
    this.camera.up.set(Math.sin(lean), Math.cos(lean), 0);
    this.camera.lookAt(this.currentFocus);
  }

  update(state: GameState, dt: number, events?: GameplayEvents) {
    if (this.disposed) return;
    const safeDt = THREE.MathUtils.clamp(dt, 0, 0.05);
    const elapsed = state.elapsed;
    this.train.update(state, elapsed, safeDt);
    this.player.update(state.player, safeDt, elapsed);
    this.enemies.update(state.enemies, safeDt, elapsed);
    this.updateCamera(state, safeDt, elapsed);
    // Friendly actors keep doing their jobs, but presentation culls only the
    // individual who enters the near-camera volume or active sightline.
    this.crew.root.visible = true;
    this.crew.update(state, safeDt, elapsed, this.currentCamera, this.currentFocus);
    const firearmDrawn = state.player.equipment !== 'wrench';
    this.player.aimAt(this.currentFocus, firearmDrawn);
    // Keep the normal over-shoulder silhouette, but if closed-hull collision
    // forces the aiming camera into the avatar, hide the local body rather than
    // ever letting it cover the reticle.
    const closeCameraThreshold = state.player.dodging ? 3.75 : BODY_HIDE_DISTANCE;
    const bodyVisible = !state.mountedTurretActive && (
      !firearmDrawn || this.playerCameraDistance >= closeCameraThreshold
    );
    this.player.root.visible = !this.authoredActors.playerReady && bodyVisible;
    this.enemies.root.visible = !this.authoredActors.enemiesReady;
    this.authoredActors.update(state, safeDt, elapsed, this.currentFocus, bodyVisible);
    this.world.update(state, safeDt, elapsed, this.camera.position);
    this.train.muzzle.getWorldPosition(this.turretMuzzlePosition);
    if (!this.authoredActors.getPlayerMuzzle(this.playerMuzzlePosition)) {
      this.player.muzzle.getWorldPosition(this.playerMuzzlePosition);
    }
    this.effects.update(state, events, safeDt, elapsed, this.turretMuzzlePosition, this.playerMuzzlePosition, this.currentFocus);
    if (this.navigationMarker.visible) {
      const pulse = 1 + Math.sin(elapsed * (this.navigationMarker.userData.urgent ? 7 : 4.2)) * 0.08;
      this.navigationMarker.scale.setScalar(pulse);
      this.navigationMarker.rotation.y = elapsed * 1.15;
      this.navigationMarker.position.y = 2.05 + Math.sin(elapsed * 3.2) * 0.08;
    }
    const lightsOn = state.systems.lights.powered;
    this.interiorLights.forEach((light, index) => {
      const flicker = state.systems.lights.damaged ? (Math.sin(elapsed * 33 + index * 3.1) > -0.2 ? 1 : 0.08) : 1;
      light.intensity = lightsOn ? 42 * flicker : state.alarm ? 1.2 : 0;
      light.color.set('#ffbd70');
    });
    this.headlight.intensity = lightsOn ? 165 : 0;
    const stormPulse = state.threatLevel > 5 && Math.sin(elapsed * 0.41 + Math.sin(elapsed * 0.093) * 3) > 0.996;
    this.lightning.intensity = stormPulse ? 360 : Math.max(0, this.lightning.intensity - safeDt * 900);
    this.lightning.position.z = -55 + Math.sin(elapsed * 0.17) * 80;
    this.station.visible = state.mode === 'station';
    if (this.dealReactor) this.dealReactor.visible = state.dealTaken;
    const skyMaterial = this.sky.material as THREE.ShaderMaterial;
    skyMaterial.uniforms.uStorm.value = 0.32 + state.threatLevel * 0.045;
    this.sky.position.copy(this.camera.position);
    if (this.scene.fog instanceof THREE.FogExp2) this.scene.fog.density = 0.009 + state.threatLevel * 0.00065;
  }

  render() {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.enemies.dispose();
    this.authoredActors.dispose();
    this.crew.dispose();
    this.train.dispose();
    this.world.dispose();
    this.effects.dispose();
    this.navigationMarker.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    });
    this.dealReactor?.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    });
    const geometries = new Set<THREE.BufferGeometry>();
    this.train.root.traverse((object) => {
      if (object instanceof THREE.Mesh && !geometries.has(object.geometry)) {
        object.geometry.dispose();
        geometries.add(object.geometry);
      }
    });
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.materials.dispose();
    this.renderer.dispose();
  }
}
