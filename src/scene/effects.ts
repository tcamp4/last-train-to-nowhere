import * as THREE from 'three';
import type { GameState, GameplayEvents, SystemId } from '../shared/types';
import type { TrainMaterials } from './materials';
import { makeMesh } from './materials';

interface Particle {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
}

export interface EffectsRig {
  root: THREE.Group;
  update(state: GameState, events: GameplayEvents | undefined, dt: number, elapsed: number, turretMuzzle: THREE.Vector3, playerMuzzle: THREE.Vector3, playerAimTarget: THREE.Vector3): void;
  setParticleBudget(count: number): void;
  dispose(): void;
}

const SYSTEM_POSITIONS: Record<SystemId, THREE.Vector3> = {
  engine: new THREE.Vector3(1.9, 1.7, -30),
  lights: new THREE.Vector3(-1.9, 2.4, 5),
  locks: new THREE.Vector3(1.9, 2.1, 12),
  radar: new THREE.Vector3(-1.8, 2.4, -25),
  turret: new THREE.Vector3(0, 4.9, 29),
  medical: new THREE.Vector3(-1.8, 2.2, 12),
  cooling: new THREE.Vector3(1.9, 2.3, -10),
};

function createPointPool(max: number, color: THREE.ColorRepresentation, size: number, opacity: number, blending: THREE.Blending) {
  const geometry = new THREE.BufferGeometry();
  const data = new Float32Array(max * 3);
  data.fill(-999);
  geometry.setAttribute('position', new THREE.BufferAttribute(data, 3));
  const material = new THREE.PointsMaterial({ color, size, transparent: true, opacity, depthWrite: false, blending, sizeAttenuation: true });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  const particles = Array.from({ length: max }, () => ({ position: new THREE.Vector3(0, -999, 0), velocity: new THREE.Vector3(), life: 0, maxLife: 1 }));
  return { points, geometry, material, particles };
}

export function createEffects(materials: TrainMaterials): EffectsRig {
  const root = new THREE.Group();
  root.name = 'pooled-world-effects';
  const sparks = createPointPool(640, '#ffb64f', 0.105, 0.95, THREE.AdditiveBlending);
  const smoke = createPointPool(180, '#5c5b56', 0.48, 0.32, THREE.NormalBlending);
  root.add(sparks.points, smoke.points);
  const tracerGeometry = new THREE.CylinderGeometry(1, 1, 1, 7, 1, true);
  const tracers = Array.from({ length: 12 }, () => {
    const material = new THREE.MeshBasicMaterial({
      color: '#ffd083',
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(tracerGeometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    root.add(mesh);
    return { mesh, material, life: 0, maxLife: 0.14 };
  });
  const casingGeometry = new THREE.CylinderGeometry(0.018, 0.018, 0.065, 8);
  const casings = Array.from({ length: 14 }, () => {
    const material = new THREE.MeshStandardMaterial({ color: '#d8a44c', metalness: 0.82, roughness: 0.28 });
    const mesh = new THREE.Mesh(casingGeometry, material);
    mesh.visible = false;
    mesh.castShadow = false;
    root.add(mesh);
    return { mesh, material, velocity: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, bounced: false };
  });
  const tracerDirection = new THREE.Vector3();
  const tracerMidpoint = new THREE.Vector3();
  const tracerEnd = new THREE.Vector3();
  const tracerUp = new THREE.Vector3(0, 1, 0);
  let tracerCursor = 0;
  let casingCursor = 0;
  let sparkCursor = 0;
  let smokeCursor = 0;
  let particleBudget = 640;

  const emitTracer = (start: THREE.Vector3, end: THREE.Vector3, color: THREE.ColorRepresentation, radius = 0.018) => {
    const tracer = tracers[tracerCursor++ % tracers.length];
    tracerDirection.subVectors(end, start);
    const length = tracerDirection.length();
    if (length < 0.01) return;
    tracerDirection.multiplyScalar(1 / length);
    tracerMidpoint.copy(start).add(end).multiplyScalar(0.5);
    tracer.mesh.position.copy(tracerMidpoint);
    tracer.mesh.quaternion.setFromUnitVectors(tracerUp, tracerDirection);
    tracer.mesh.scale.set(radius, length, radius);
    tracer.material.color.set(color);
    tracer.material.opacity = 1;
    tracer.mesh.visible = true;
    tracer.life = tracer.maxLife;
  };

  const cueMaterial = materials.warning.clone();
  cueMaterial.transparent = true;
  cueMaterial.opacity = 0.86;
  const cues = new Map<SystemId, THREE.Group>();
  (Object.keys(SYSTEM_POSITIONS) as SystemId[]).forEach((id) => {
    const cue = new THREE.Group();
    cue.name = `damage-cue-${id}`;
    const halo = makeMesh(new THREE.TorusGeometry(0.24, 0.035, 8, 24), cueMaterial, false, false);
    halo.rotation.x = Math.PI / 2;
    cue.add(halo);
    for (let i = 0; i < 3; i += 1) {
      const chevron = makeMesh(new THREE.ConeGeometry(0.055, 0.18, 8), cueMaterial, false, false);
      chevron.position.set(Math.cos(i * Math.PI * 2 / 3) * 0.34, 0, Math.sin(i * Math.PI * 2 / 3) * 0.34);
      chevron.rotation.z = Math.PI;
      cue.add(chevron);
    }
    cue.position.copy(SYSTEM_POSITIONS[id]);
    cue.visible = false;
    cues.set(id, cue);
    root.add(cue);
  });

  const muzzleFlash = new THREE.PointLight('#ffad52', 0, 7, 2.2);
  const muzzleFlareMaterial = new THREE.MeshBasicMaterial({ color: '#fff1b0', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const muzzleFlare = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), muzzleFlareMaterial);
  muzzleFlare.visible = false;
  muzzleFlare.renderOrder = 12;
  root.add(muzzleFlash, muzzleFlare);
  let muzzleLife = 0;

  const emitCasing = (origin: THREE.Vector3, yaw: number) => {
    const casing = casings[casingCursor++ % casings.length];
    casing.mesh.position.copy(origin).add(new THREE.Vector3(0, 0.035, 0));
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    casing.velocity.set(rightX * (1.25 + Math.random() * 0.65), 1.7 + Math.random() * 0.65, rightZ * (1.25 + Math.random() * 0.65));
    casing.spin.set(9 + Math.random() * 8, 12 + Math.random() * 11, 7 + Math.random() * 9);
    casing.life = 1.35;
    casing.bounced = false;
    casing.mesh.visible = true;
  };

  const emitSpark = (origin: THREE.Vector3, strength = 1) => {
    const particle = sparks.particles[sparkCursor++ % particleBudget];
    particle.position.copy(origin).add(new THREE.Vector3((Math.random() - 0.5) * 0.22, (Math.random() - 0.5) * 0.22, (Math.random() - 0.5) * 0.22));
    const angle = Math.random() * Math.PI * 2;
    const speed = (2.8 + Math.random() * 8) * strength;
    particle.velocity.set(Math.cos(angle) * speed, 2.8 + Math.random() * 6 * strength, Math.sin(angle) * speed);
    particle.life = particle.maxLife = 0.28 + Math.random() * 0.72;
  };
  const emitSmoke = (origin: THREE.Vector3) => {
    const particle = smoke.particles[smokeCursor++ % smoke.particles.length];
    particle.position.copy(origin).add(new THREE.Vector3((Math.random() - 0.5) * 0.42, 0, (Math.random() - 0.5) * 0.42));
    particle.velocity.set((Math.random() - 0.5) * 0.32, 0.45 + Math.random() * 0.65, (Math.random() - 0.5) * 0.3);
    particle.life = particle.maxLife = 1.5 + Math.random() * 2.2;
  };
  const updatePool = (pool: typeof sparks, dt: number, gravity: number, drag: number) => {
    const array = pool.geometry.attributes.position.array as Float32Array;
    pool.particles.forEach((particle, index) => {
      if (particle.life > 0) {
        particle.life -= dt;
        particle.velocity.y += gravity * dt;
        particle.velocity.multiplyScalar(Math.exp(-drag * dt));
        particle.position.addScaledVector(particle.velocity, dt);
      } else {
        particle.position.y = -999;
      }
      array[index * 3] = particle.position.x;
      array[index * 3 + 1] = particle.position.y;
      array[index * 3 + 2] = particle.position.z;
    });
    pool.geometry.attributes.position.needsUpdate = true;
  };

  return {
    root,
    update(state, events, dt, elapsed, turretMuzzle, playerMuzzle, playerAimTarget) {
      const firedMuzzle = events?.turretFired ? turretMuzzle : events?.shot ? playerMuzzle : undefined;
      if (firedMuzzle) {
        muzzleLife = 0.075;
        const count = events?.turretFired ? 28 : events?.shot === 'arc-tool' ? 22 : events?.shot === 'sidearm' ? 13 : 5;
        for (let i = 0; i < count; i += 1) emitSpark(firedMuzzle, events?.turretFired || events?.shot === 'arc-tool' ? 1.2 : 0.8);
        muzzleFlash.position.copy(firedMuzzle);
        muzzleFlare.position.copy(firedMuzzle);
        muzzleFlare.scale.setScalar(events?.turretFired ? 2.1 : events?.shot === 'arc-tool' ? 1.55 : 1);
        muzzleFlare.visible = true;
        if (events?.shot === 'sidearm') emitCasing(firedMuzzle, state.player.yaw);
        const enemy = events?.enemyHit
          ? state.enemies.find((candidate) => candidate.id === events.enemyHit?.id)
          : undefined;
        if (enemy) {
          tracerEnd.set(enemy.position.x, enemy.position.y + (enemy.type === 'ripper' ? 1.15 : 0.65), enemy.position.z);
        } else if (events?.turretFired) {
          tracerEnd.copy(turretMuzzle).add(new THREE.Vector3(Math.sin(state.turretYaw) * 42, 0, Math.cos(state.turretYaw) * 42));
        } else {
          tracerDirection.subVectors(playerAimTarget, playerMuzzle).normalize();
          tracerEnd.copy(playerMuzzle).addScaledVector(tracerDirection, events?.shot === 'arc-tool' ? 18 : 26);
        }
        const tracerRadius = events?.turretFired ? 0.04 : events?.shot === 'arc-tool' ? 0.034 : 0.028;
        emitTracer(
          firedMuzzle,
          tracerEnd,
          events?.shot === 'arc-tool' ? '#7dfcff' : events?.turretFired ? '#fff0b1' : '#ffbd67',
          tracerRadius,
        );
        // A pale inner core keeps the shot readable against both black windows
        // and the train's hot amber interior lighting.
        emitTracer(firedMuzzle, tracerEnd, events?.shot === 'arc-tool' ? '#eaffff' : '#fff8dc', tracerRadius * 0.34);
      }
      if (events?.enemyHit) {
        const enemy = state.enemies.find((candidate) => candidate.id === events.enemyHit?.id);
        if (enemy) {
          const origin = new THREE.Vector3(enemy.position.x, enemy.position.y + 0.7, enemy.position.z);
          for (let i = 0; i < Math.min(28, 6 + events.enemyHit.amount); i += 1) emitSpark(origin, 0.7);
        }
      }
      let damageIndex = 0;
      (Object.keys(state.systems) as SystemId[]).forEach((id) => {
        const system = state.systems[id];
        const cue = cues.get(id)!;
        cue.visible = system.damaged;
        if (system.damaged) {
          cue.rotation.y += dt * 1.8;
          cue.position.y = SYSTEM_POSITIONS[id].y + Math.sin(elapsed * 3.1 + damageIndex) * 0.1;
          cue.scale.setScalar(0.92 + Math.sin(elapsed * 5.7 + damageIndex) * 0.1);
          if (Math.random() < dt * 8) emitSpark(SYSTEM_POSITIONS[id], 0.42);
          if ((system.damageKind === 'fire' || system.damageKind === 'overheat') && Math.random() < dt * 5) emitSmoke(SYSTEM_POSITIONS[id]);
          damageIndex += 1;
        }
      });
      // Speed-proportional wheel sparks sell hard rail contact, pooled to avoid GC churn.
      if (state.speed > 35 && Math.random() < dt * (state.speed - 30) * 0.32) {
        const side = Math.random() > 0.5 ? 1 : -1;
        const origin = new THREE.Vector3(side * 3.05, -1.18, -28 + Math.floor(Math.random() * 4) * 18);
        for (let i = 0; i < 4; i += 1) emitSpark(origin, 0.55);
      }
      updatePool(sparks, dt, -15, 0.45);
      updatePool(smoke as typeof sparks, dt, 0.12, 0.7);
      muzzleLife = Math.max(0, muzzleLife - dt);
      muzzleFlash.intensity = muzzleLife > 0 ? 32 * (muzzleLife / 0.075) : 0;
      muzzleFlareMaterial.opacity = muzzleLife > 0 ? Math.pow(muzzleLife / 0.075, 0.45) : 0;
      muzzleFlare.visible = muzzleLife > 0;
      if (muzzleFlare.visible) muzzleFlare.rotation.z += dt * 28;
      tracers.forEach((tracer) => {
        if (tracer.life <= 0) return;
        tracer.life = Math.max(0, tracer.life - dt);
        tracer.material.opacity = Math.pow(tracer.life / tracer.maxLife, 0.55);
        tracer.mesh.visible = tracer.life > 0;
      });
      casings.forEach((casing) => {
        if (casing.life <= 0) return;
        casing.life = Math.max(0, casing.life - dt);
        casing.velocity.y -= 8.8 * dt;
        casing.mesh.position.addScaledVector(casing.velocity, dt);
        casing.mesh.rotation.x += casing.spin.x * dt;
        casing.mesh.rotation.y += casing.spin.y * dt;
        casing.mesh.rotation.z += casing.spin.z * dt;
        if (!casing.bounced && casing.mesh.position.y < 0.055) {
          casing.mesh.position.y = 0.055;
          casing.velocity.y = Math.abs(casing.velocity.y) * 0.34;
          casing.velocity.x *= 0.55;
          casing.velocity.z *= 0.55;
          casing.bounced = true;
        }
        casing.mesh.visible = casing.life > 0;
      });
      cueMaterial.emissiveIntensity = 1.2 + (Math.sin(elapsed * 8) + 1) * 1.5;
    },
    setParticleBudget(count) {
      particleBudget = THREE.MathUtils.clamp(Math.floor(count * 0.5), 80, sparks.particles.length);
    },
    dispose() {
      sparks.geometry.dispose(); sparks.material.dispose();
      smoke.geometry.dispose(); smoke.material.dispose();
      tracerGeometry.dispose();
      tracers.forEach((tracer) => tracer.material.dispose());
      casingGeometry.dispose();
      casings.forEach((casing) => casing.material.dispose());
      muzzleFlare.geometry.dispose();
      muzzleFlareMaterial.dispose();
      cueMaterial.dispose();
    },
  };
}
