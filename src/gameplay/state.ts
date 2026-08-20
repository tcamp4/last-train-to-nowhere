import type { GameState } from '../shared/types';
import { attachmentPointsFor, createPassengers, createSystems, createUpgrades } from './definitions';

export const DEFAULT_SEED = 0x4c_54_4e;

export function createInitialGameState(seed = DEFAULT_SEED): GameState {
  return {
    mode: 'title',
    previousMode: 'title',
    seed: seed >>> 0,
    elapsed: 0,
    regionTime: 0,
    regionDuration: 72,
    region: 1,
    stationName: 'Cinder Junction',
    objective: 'Bring the engine online and depart Cinder Junction.',
    threatLevel: 1,
    speed: 0,
    hull: 100,
    fuel: 82,
    scrap: 34,
    powerProduction: 12,
    battery: 36,
    maxBattery: 50,
    powerDraw: 0,
    alarm: false,
    weather: 'ash-storm',
    player: {
      position: { x: 0, y: 0, z: -9 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      aimPitch: 0,
      health: 100,
      maxHealth: 100,
      carIndex: 1,
      equipment: 'sidearm',
      ammo: 18,
      reserveAmmo: 54,
      toolCharge: 100,
      sprinting: false,
      dodging: false,
      aiming: false,
      moveSpeed: 0,
      dodgeCooldown: 0,
      weaponCooldown: 0,
      reloadRemaining: 0,
      reloading: false,
      recoil: 0,
      shotSequence: 0,
    },
    systems: createSystems(),
    enemies: [],
    passengers: createPassengers(),
    upgrades: createUpgrades(),
    nextEnemyId: 1,
    stationVisits: 0,
    dealTaken: false,
    routeChoice: 'salt-cut',
    mountedTurretActive: false,
    turretYaw: 0,
    turretCooldown: 0,
    turretAimAssist: false,
    turretTargetId: null,
    turretOperator: null,
    message: 'The ash line is waiting. Keep the train alive.',
    messageTimer: 6,
    shake: 0,
    gameOverReason: '',
    debug: false,
  };
}

export function cloneGameState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

/** Adds deterministic defaults to saves created before new authoritative fields existed. */
export function hydrateGameState(state: GameState): GameState {
  const hydrated = cloneGameState(state);
  if (!hydrated.player.velocity || !Number.isFinite(hydrated.player.velocity.x) || !Number.isFinite(hydrated.player.velocity.z)) {
    hydrated.player.velocity = { x: 0, y: 0, z: 0 };
  }
  hydrated.player.velocity.y = 0;
  hydrated.player.aimPitch = Number.isFinite(hydrated.player.aimPitch)
    ? Math.max(-0.32, Math.min(0.32, hydrated.player.aimPitch))
    : 0;
  hydrated.player.moveSpeed = Number.isFinite(hydrated.player.moveSpeed) ? Math.max(0, hydrated.player.moveSpeed) : 0;
  hydrated.player.dodgeCooldown = Number.isFinite(hydrated.player.dodgeCooldown) ? Math.max(0, hydrated.player.dodgeCooldown) : 0;
  hydrated.player.weaponCooldown = Number.isFinite(hydrated.player.weaponCooldown) ? Math.max(0, hydrated.player.weaponCooldown) : 0;
  hydrated.player.reserveAmmo = Number.isFinite(hydrated.player.reserveAmmo) ? Math.max(0, Math.trunc(hydrated.player.reserveAmmo)) : 54;
  hydrated.player.reloadRemaining = Number.isFinite(hydrated.player.reloadRemaining) ? Math.max(0, hydrated.player.reloadRemaining) : 0;
  hydrated.player.reloading = hydrated.player.reloading === true && hydrated.player.reloadRemaining > 0;
  hydrated.player.recoil = Number.isFinite(hydrated.player.recoil) ? Math.max(0, hydrated.player.recoil) : 0;
  hydrated.player.shotSequence = Number.isFinite(hydrated.player.shotSequence) ? Math.max(0, Math.trunc(hydrated.player.shotSequence)) : 0;
  if (hydrated.routeChoice !== 'salt-cut' && hydrated.routeChoice !== 'dead-forest') {
    hydrated.routeChoice = 'salt-cut';
  }
  for (const enemy of hydrated.enemies) {
    if (typeof enemy.attachmentPointId === 'string' && enemy.attachmentPointId.length > 0) continue;
    const points = attachmentPointsFor(enemy.targetCar, enemy.side);
    enemy.attachmentPointId = points[enemy.id % Math.max(1, points.length)]?.id ?? '';
  }
  for (const enemy of hydrated.enemies) {
    enemy.hitStun = Number.isFinite(enemy.hitStun) ? Math.max(0, enemy.hitStun) : 0;
  }
  hydrated.mountedTurretActive = hydrated.mountedTurretActive === true;
  hydrated.turretYaw = Number.isFinite(hydrated.turretYaw)
    ? Math.max(-1.12, Math.min(1.12, hydrated.turretYaw))
    : 0;
  hydrated.turretCooldown = Number.isFinite(hydrated.turretCooldown)
    ? Math.max(0, hydrated.turretCooldown)
    : 0;
  hydrated.turretAimAssist = hydrated.turretAimAssist === true;
  hydrated.turretTargetId = Number.isFinite(hydrated.turretTargetId)
    ? hydrated.turretTargetId
    : null;
  hydrated.turretOperator =
    hydrated.turretOperator === 'player' || hydrated.turretOperator === 'oren'
      ? hydrated.turretOperator
      : null;
  const passengerDefaults = createPassengers();
  for (const passenger of hydrated.passengers) {
    const defaults = passengerDefaults.find((candidate) => candidate.id === passenger.id);
    if (!defaults) continue;
    if (!passenger.position || !Number.isFinite(passenger.position.x) || !Number.isFinite(passenger.position.z)) {
      passenger.position = { ...defaults.position };
    }
    passenger.position.y = 0;
    passenger.carIndex = Number.isFinite(passenger.carIndex)
      ? Math.max(0, Math.min(3, Math.trunc(passenger.carIndex)))
      : defaults.carIndex;
    if (!['idle', 'moving', 'repairing', 'medical', 'turret', 'sheltering'].includes(passenger.activity)) {
      passenger.activity = 'idle';
    }
    passenger.lastBriefingVisit = Number.isFinite(passenger.lastBriefingVisit)
      ? passenger.lastBriefingVisit
      : -1;
  }
  return hydrated;
}
