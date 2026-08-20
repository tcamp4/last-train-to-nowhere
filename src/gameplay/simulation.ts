import type {
  DamageKind,
  EnemyState,
  EnemyType,
  EquipmentId,
  GameState,
  GameplayEvents,
  InputSnapshot,
  PassengerConversationChoice,
  PassengerState,
  RouteChoice,
  SystemId,
} from '../shared/types';
import {
  ENEMY_DEFINITIONS,
  EQUIPMENT_ORDER,
  SYSTEM_POSITIONS,
  TRAIN_BOUNDS,
  attachmentPointById,
  attachmentPointsFor,
  carIndexForZ,
  playerLateralBounds,
} from './definitions';
import {
  DEFAULT_SAVE_KEY,
  type StorageLike,
  deserializeGameState,
  loadGameFromStorage,
  saveGameToStorage,
  serializeGameState,
} from './persistence';
import { enforcePowerCapacity, setSystemPowered, tickBattery, updatePowerDraw } from './power';
import {
  passengerEffectiveness,
  talkToPassenger as resolvePassengerConversation,
  type PassengerConversationResult,
} from './passengers';
import {
  type RepairPrompt,
  type RepairResult,
  applySystemDamage,
  getRepairPrompt,
  performRepairStep,
} from './repairs';
import { DEFAULT_SEED, createInitialGameState, hydrateGameState } from './state';
import { buildRenderGameText } from './text';

export const EMPTY_INPUT: Readonly<InputSnapshot> = Object.freeze({
  forward: 0,
  strafe: 0,
  sprint: false,
  dodgePressed: false,
  reloadPressed: false,
  interactPressed: false,
  primaryPressed: false,
  primaryHeld: false,
  secondaryHeld: false,
  tabPressed: false,
  pausePressed: false,
  equipmentDelta: 0,
  numberSelect: 0,
  cameraDeltaX: 0,
  cameraDeltaY: 0,
});

const FIXED_STEP = 1 / 60;
const WAVE_INTERVAL = 14;
const CAMERA_PITCH_MIN = -0.32;
const CAMERA_PITCH_MAX = 0.32;
const DODGE_DURATION = 0.24;
const DODGE_COOLDOWN = 0.72;
const TURRET_POSITION = Object.freeze({ x: 0, y: 0, z: 29 });
const TURRET_MOUNT_RANGE = 2.6;
const TURRET_YAW_LIMIT = 1.12;
const TURRET_MAX_RANGE = 60;
const CREW_HOME: Readonly<Record<string, { x: number; y: number; z: number }>> = Object.freeze({
  'mara-vale': { x: 1.8, y: 0, z: -6.5 },
  'dr-ives': { x: -1.8, y: 0, z: 6 },
  'oren-brass': { x: 1.8, y: 0, z: 24 },
});
const CREW_SHELTER = Object.freeze({ x: 0, y: 0, z: 9 });
const STATIONS = [
  'Lantern Mile Depot',
  'Gallows Switch',
  'Saint Orra Platform',
  'The Rusted Meridian',
  'Blackglass Checkpoint',
] as const;

const DAMAGE_BY_ENEMY: Readonly<Record<EnemyType, DamageKind>> = Object.freeze({
  clinger: 'breach',
  leeche: 'electrical',
  ripper: 'jam',
});

/**
 * Authoritative, renderer-independent vertical-slice simulation. All meaningful
 * run state lives in `state`, so a save/load round trip resumes deterministically.
 */
export class GameplaySimulation {
  public state: GameState;

  private dodgeRemaining = 0;
  private dodgeDirection = { x: 0, z: -1 };

  public constructor(seedOrState: number | GameState = DEFAULT_SEED) {
    this.state =
      typeof seedOrState === 'number'
        ? createInitialGameState(seedOrState)
        : hydrateGameState(seedOrState);
    updatePowerDraw(this.state);
  }

  public startNewRun(seed = this.state.seed): GameState {
    this.state = createInitialGameState(seed);
    this.state.mode = 'travel';
    this.state.previousMode = 'title';
    this.state.speed = 38;
    this.state.objective = 'Survive the Ash Barrens and reach Lantern Mile Depot.';
    this.state.message = 'K-12 drawn · hold RMB to aim · LMB to fire · 1/2/3 change equipment.';
    this.state.messageTimer = 5;
    this.dodgeRemaining = 0;
    this.dodgeDirection = { x: 0, z: -1 };
    updatePowerDraw(this.state);
    return this.state;
  }

  public update(dtSeconds: number, partialInput: Partial<InputSnapshot> = {}): GameplayEvents {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return {};
    const input: InputSnapshot = { ...EMPTY_INPUT, ...partialInput };
    const events: GameplayEvents = {};

    if (input.pausePressed) {
      this.pause();
      return events;
    }
    if (this.state.mode === 'paused' || this.state.mode === 'title' || this.state.mode === 'gameover') {
      return events;
    }

    this.applyPressedInput(input, events);
    let remaining = Math.min(dtSeconds, 120);
    while (remaining > 1e-9 && this.state.mode === 'travel') {
      const dt = Math.min(FIXED_STEP, remaining);
      this.tickTravel(dt, input, events);
      remaining -= dt;
    }

    if (this.state.mode === 'station') {
      this.state.messageTimer = Math.max(0, this.state.messageTimer - Math.min(dtSeconds, 120));
      this.state.player.sprinting = false;
      this.state.player.dodging = false;
      this.state.player.aiming = input.secondaryHeld;
    }
    return events;
  }

  /** Alias suited to `window.advanceTime(ms)` integrations. */
  public advanceTime(milliseconds: number, input: Partial<InputSnapshot> = {}): GameplayEvents {
    return this.update(milliseconds / 1000, input);
  }

  public toggleSystem(id: SystemId, force = !this.state.systems[id].powered): boolean {
    const enabled = setSystemPowered(this.state, id, force);
    if (id === 'turret' && !enabled && this.state.mountedTurretActive) this.dismountTurret();
    this.state.message = enabled
      ? `${this.state.systems[id].label}: power routed.`
      : `${this.state.systems[id].label}: offline.`;
    this.state.messageTimer = 2.8;
    return enabled;
  }

  public setSystemPriority(id: SystemId, priority: number): void {
    this.state.systems[id].priority = clamp(Math.round(priority), 0, 10);
    enforcePowerCapacity(this.state);
  }

  public selectEquipment(equipment: EquipmentId): EquipmentId {
    this.state.player.equipment = equipment;
    this.state.player.weaponCooldown = Math.max(this.state.player.weaponCooldown, 0.12);
    this.state.player.recoil = 0;
    this.state.player.reloading = false;
    this.state.player.reloadRemaining = 0;
    return equipment;
  }

  public cycleEquipment(delta: number): EquipmentId {
    if (delta === 0) return this.state.player.equipment;
    const current = EQUIPMENT_ORDER.indexOf(this.state.player.equipment);
    const direction = Math.sign(delta);
    const next = (current + direction + EQUIPMENT_ORDER.length) % EQUIPMENT_ORDER.length;
    return this.selectEquipment(EQUIPMENT_ORDER[next] ?? 'wrench');
  }

  /** Current reticle-valid target for the equipped handheld weapon. */
  public getHandheldCombatTarget(): EnemyState | undefined {
    if (
      this.state.mode !== 'travel' ||
      this.state.mountedTurretActive ||
      this.state.player.equipment === 'wrench'
    ) return undefined;
    return this.findCombatTarget(this.state.player.equipment);
  }

  public attack(): GameplayEvents {
    if (this.state.mode !== 'travel') return {};
    if (this.state.mountedTurretActive) return this.fireMountedTurret();
    const equipment = this.state.player.equipment;
    const events: GameplayEvents = { shot: equipment };

    if (equipment === 'sidearm') {
      if (this.state.player.ammo <= 0) {
        this.setMessage('The sidearm clicks empty.', 2);
        return {};
      }
      this.state.player.ammo -= 1;
    } else if (equipment === 'arc-tool') {
      if (this.state.player.toolCharge < 12) {
        this.setMessage('The arc-tool needs charge.', 2);
        return {};
      }
      this.state.player.toolCharge -= 12;
    }

    const target = this.findCombatTarget(equipment);
    if (!target) return events;
    let damage = equipment === 'wrench' ? 42 : equipment === 'sidearm' ? 34 : 38;
    if (equipment === 'arc-tool' && target.type === 'leeche') damage = 70;
    this.hitEnemy(target, damage);
    events.enemyHit = { id: target.id, amount: damage };
    events.impact = equipment === 'wrench' ? 0.25 : 0.14;
    return events;
  }

  public mountTurret(): boolean {
    const turret = this.state.systems.turret;
    if (this.state.mode !== 'travel' || !turret.powered || turret.damaged || turret.health <= 20) {
      this.setMessage('The rear turret has no usable firing circuit.', 2.5);
      return false;
    }
    if (!this.isAtTurretStation()) return false;
    this.state.mountedTurretActive = true;
    this.state.turretOperator = 'player';
    this.state.turretYaw = clamp(this.state.turretYaw, -TURRET_YAW_LIMIT, TURRET_YAW_LIMIT);
    setPosition(this.state.player.position, TURRET_POSITION);
    this.state.player.carIndex = 3;
    this.state.player.sprinting = false;
    this.state.player.dodging = false;
    this.state.player.aiming = true;
    this.updateMountedTurretLock();
    this.setMessage('Rear turret mounted. Mouse aims · fire uses the primary trigger · E releases.', 4);
    return true;
  }

  /** Shared interaction predicate so presentation never advertises a dead E prompt. */
  public isAtTurretStation(): boolean {
    return Math.hypot(
      this.state.player.position.x - TURRET_POSITION.x,
      this.state.player.position.z - TURRET_POSITION.z,
    ) <= TURRET_MOUNT_RANGE;
  }

  public dismountTurret(): boolean {
    if (!this.state.mountedTurretActive) return false;
    this.state.mountedTurretActive = false;
    this.state.turretAimAssist = false;
    this.state.turretTargetId = null;
    this.state.player.aiming = false;
    const oren = this.findPassenger('oren-brass');
    this.state.turretOperator = oren?.activity === 'turret' ? 'oren' : null;
    this.setMessage('Turret controls released.', 2);
    return true;
  }

  public fireMountedTurret(): GameplayEvents {
    if (!this.state.mountedTurretActive) return {};
    const turret = this.state.systems.turret;
    if (!turret.powered || turret.damaged || turret.health <= 20) {
      this.setMessage('The rear turret has no usable firing circuit.', 2.5);
      return {};
    }
    if (this.state.turretCooldown > 0) return {};
    this.updateMountedTurretLock();
    const target = this.state.enemies.find(
      (enemy) => enemy.id === this.state.turretTargetId && this.isRearTurretTarget(enemy),
    );
    if (!target) {
      this.setMessage('No target in the firing reticle.', 1.25);
      return {};
    }
    return this.fireTurretAt(target);
  }

  public spawnEnemy(
    type?: EnemyType,
    targetCar?: number,
    side?: -1 | 1,
    attachmentPointId?: string,
  ): EnemyState {
    const resolvedType = type ?? this.randomEnemyType();
    const requestedPoint = attachmentPointId ? attachmentPointById(attachmentPointId) : undefined;
    const resolvedCar = clamp(
      requestedPoint?.carIndex ??
        (targetCar === undefined ? Math.floor(this.random() * 4) : Math.trunc(targetCar)),
      0,
      3,
    );
    const resolvedSide: -1 | 1 = requestedPoint?.side ?? side ?? (this.random() < 0.5 ? -1 : 1);
    const candidatePoints = attachmentPointsFor(resolvedCar, resolvedSide);
    const point =
      requestedPoint ?? candidatePoints[Math.floor(this.random() * Math.max(1, candidatePoints.length))];
    if (!point) throw new Error(`No exterior attachment point for car ${resolvedCar}.`);
    const definition = ENEMY_DEFINITIONS[resolvedType];
    const enemy: EnemyState = {
      id: this.state.nextEnemyId++,
      type: resolvedType,
      stage: 'approach',
      health: definition.health,
      position: { ...point.approach },
      targetCar: resolvedCar,
      side: resolvedSide,
      attachmentPointId: point.id,
      timer: 0,
      hitStun: 0,
    };
    this.state.enemies.push(enemy);
    this.state.alarm = true;
    this.setMessage(
      this.state.systems.radar.powered
        ? `Radar contact: ${resolvedType} closing on car ${resolvedCar + 1}.`
        : 'Something strikes the outer skin of the train.',
      4,
    );
    return enemy;
  }

  public damageSystem(id: SystemId, amount: number, kind?: DamageKind): number {
    const damaged = applySystemDamage(this.state, id, amount, kind);
    if (id === 'turret' && damaged > 0 && this.state.mountedTurretActive) this.dismountTurret();
    if (damaged > 0) {
      this.state.alarm = true;
      this.setMessage(`${this.state.systems[id].label} damaged.`, 3.5);
    }
    return damaged;
  }

  public getRepairPrompt(id: SystemId): RepairPrompt | null {
    return getRepairPrompt(this.state, id);
  }

  public performRepair(id: SystemId, stepId?: string): RepairResult {
    const prompt = getRepairPrompt(this.state, id);
    if (!prompt) return { ok: false, completed: false, reason: 'not-damaged' };
    const contextFailure = this.repairContextFailure(id);
    if (contextFailure) {
      return {
        ok: false,
        completed: false,
        reason: contextFailure,
        prompt,
      };
    }
    const result = performRepairStep(this.state, id, this.state.player.equipment, stepId);
    if (result.completed) {
      this.setMessage(`${this.state.systems[id].label} restored. Re-route power when ready.`, 4);
    } else if (result.ok && result.prompt) {
      this.setMessage(`Next: ${result.prompt.label}.`, 2.5);
    } else if (result.reason === 'wrong-equipment' && result.prompt) {
      this.setMessage(`Equip ${result.prompt.equipment}: ${result.prompt.label}.`, 3);
    }
    return result;
  }

  public getContextualRepairTarget(maxDistance = 2.35, minimumFacingDot = 0.42): SystemId | null {
    if (this.state.mountedTurretActive) return null;
    const forward = forwardFromYaw(this.state.player.yaw);
    let best: { id: SystemId; score: number } | undefined;
    for (const [id, position] of Object.entries(SYSTEM_POSITIONS) as [
      SystemId,
      (typeof SYSTEM_POSITIONS)[SystemId],
    ][]) {
      if (!this.state.systems[id].damaged) continue;
      const dx = position.x - this.state.player.position.x;
      const dz = position.z - this.state.player.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > maxDistance) continue;
      const facingDot = distance <= 0.25 ? 1 : (forward.x * dx + forward.z * dz) / distance;
      if (facingDot < minimumFacingDot) continue;
      const score = distance + (1 - facingDot) * 0.8;
      if (!best || score < best.score) best = { id, score };
    }
    return best?.id ?? null;
  }

  /** Nearest physical console the player can operate in the world. */
  public getContextualSystemTarget(maxDistance = 2.65, minimumFacingDot = 0.18): SystemId | null {
    if (this.state.mountedTurretActive) return null;
    const forward = forwardFromYaw(this.state.player.yaw);
    let best: { id: SystemId; score: number } | undefined;
    for (const [id, position] of Object.entries(SYSTEM_POSITIONS) as [
      SystemId,
      (typeof SYSTEM_POSITIONS)[SystemId],
    ][]) {
      const dx = position.x - this.state.player.position.x;
      const dz = position.z - this.state.player.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > maxDistance) continue;
      const facingDot = distance <= 0.25 ? 1 : (forward.x * dx + forward.z * dz) / distance;
      if (facingDot < minimumFacingDot) continue;
      const score = distance + (1 - facingDot) * 0.55;
      if (!best || score < best.score) best = { id, score };
    }
    return best?.id ?? null;
  }

  public getContextualPassenger(maxDistance = 2.15, minimumFacingDot = 0.08): PassengerState | undefined {
    if (this.state.mountedTurretActive) return undefined;
    const forward = forwardFromYaw(this.state.player.yaw);
    return this.state.passengers
      .filter((passenger) => passenger.health > 0)
      .map((passenger) => {
        const dx = passenger.position.x - this.state.player.position.x;
        const dz = passenger.position.z - this.state.player.position.z;
        const distance = Math.hypot(dx, dz);
        const facingDot = distance <= 0.25 ? 1 : (forward.x * dx + forward.z * dz) / Math.max(0.001, distance);
        return { passenger, distance, facingDot };
      })
      .filter((candidate) => candidate.distance <= maxDistance && candidate.facingDot >= minimumFacingDot)
      .sort((a, b) => a.distance - b.distance)[0]?.passenger;
  }

  public checkInWithPassenger(id: string): boolean {
    const passenger = this.getContextualPassenger();
    if (!passenger || passenger.id !== id) return false;
    const status = passenger.activity === 'moving'
      ? `Moving to ${passenger.targetSystem ? this.state.systems[passenger.targetSystem].label : 'the next post'}.`
      : passenger.activity === 'repairing'
        ? `Working the ${passenger.targetSystem ? this.state.systems[passenger.targetSystem].label : 'damaged circuit'}.`
        : passenger.activity === 'medical'
          ? 'Medical station ready when the bus has power.'
          : passenger.activity === 'turret'
            ? 'Rear sightline covered. Keep the firing circuit alive.'
            : passenger.activity === 'sheltering'
              ? 'Taking cover until the breach is contained.'
              : passenger.ability;
    this.setMessage(`${passenger.name}: ${status}`, 4.5);
    return true;
  }

  public reachStation(): boolean {
    if (this.state.mode !== 'travel') return false;
    this.state.mountedTurretActive = false;
    this.state.turretAimAssist = false;
    this.state.turretTargetId = null;
    this.state.turretOperator = null;
    this.state.previousMode = 'travel';
    this.state.mode = 'station';
    this.state.speed = 0;
    this.state.regionTime = this.state.regionDuration;
    this.state.stationVisits += 1;
    this.state.stationName = STATIONS[(this.state.stationVisits - 1) % STATIONS.length] ?? STATIONS[0];
    this.state.scrap += 6 + this.state.region * 2;
    this.state.enemies = [];
    this.state.alarm = Object.values(this.state.systems).some((system) => system.damaged);
    this.state.objective = 'Trade, repair, or take the offer—then pull the departure lever.';
    this.setMessage(`Safe for now: ${this.state.stationName}.`, 6);
    return true;
  }

  public purchaseUpgrade(id: string): boolean {
    if (this.state.mode !== 'station') return false;
    const upgrade = this.state.upgrades.find((candidate) => candidate.id === id);
    if (!upgrade || upgrade.purchased || this.state.scrap < upgrade.cost) return false;

    this.state.scrap -= upgrade.cost;
    upgrade.purchased = true;
    switch (upgrade.id) {
      case 'generator-coils':
        this.state.powerProduction += 3;
        break;
      case 'battery-bank':
        this.state.maxBattery += 30;
        this.state.battery += 30;
        break;
      case 'reinforced-doors':
        this.state.systems.locks.health = Math.min(100, this.state.systems.locks.health + 20);
        break;
      case 'turret-servos':
        this.state.systems.turret.health = Math.min(100, this.state.systems.turret.health + 20);
        break;
      case 'medical-bunks':
        this.state.systems.medical.health = Math.min(100, this.state.systems.medical.health + 20);
        break;
      case 'repair-rig':
        break;
    }
    enforcePowerCapacity(this.state);
    this.setMessage(`${upgrade.label} installed.`, 4);
    return true;
  }

  public acceptStationDeal(): boolean {
    if (this.state.mode !== 'station' || this.state.dealTaken) return false;
    this.state.dealTaken = true;
    this.state.fuel = Math.min(120, this.state.fuel + 28);
    this.state.powerProduction += 2;
    const doctor = this.state.passengers.find((passenger) => passenger.id === 'dr-ives');
    if (doctor) doctor.morale = Math.max(0, doctor.morale - 15);
    this.setMessage('The unmarked reactor is yours. Its beacon cannot be disabled.', 6);
    return true;
  }

  public chooseRoute(route: RouteChoice): boolean {
    if (this.state.mode !== 'station') return false;
    this.state.routeChoice = route;
    this.setMessage(
      route === 'salt-cut'
        ? 'Route marked: fast exposed rails through the Salt Cut.'
        : 'Route marked: the slow Dead Forest branch. Heavy tracks detected.',
      3.5,
    );
    return true;
  }

  public talkToPassenger(
    passengerId: string,
    choice: PassengerConversationChoice,
  ): PassengerConversationResult {
    const result = resolvePassengerConversation(this.state, passengerId, choice);
    this.setMessage(result.text, result.ok ? 5 : 3);
    return result;
  }

  public repairTrainAtStation(cost = 12): boolean {
    if (this.state.mode !== 'station' || this.state.scrap < cost) return false;
    const needsRepair =
      this.state.hull < 100 || Object.values(this.state.systems).some((system) => system.damaged);
    if (!needsRepair) return false;
    this.state.scrap -= cost;
    this.state.hull = Math.min(100, this.state.hull + 45);
    for (const system of Object.values(this.state.systems)) {
      system.health = 100;
      system.damaged = false;
      system.damageKind = undefined;
      system.repairProgress = 0;
    }
    this.setMessage('Station crews plate the hull and replace the ruined circuits.', 5);
    return true;
  }

  public departStation(): boolean {
    if (this.state.mode !== 'station') return false;
    this.state.previousMode = 'station';
    this.state.mode = 'travel';
    this.state.region += 1;
    this.state.regionTime = 0;
    const baseDuration = 72 + Math.min(28, (this.state.region - 1) * 7);
    this.state.regionDuration =
      baseDuration + (this.state.routeChoice === 'dead-forest' ? 12 : -8);
    this.state.threatLevel =
      1 +
      Math.floor(this.state.region * 0.75) +
      (this.state.dealTaken ? 1 : 0) +
      (this.state.routeChoice === 'salt-cut' ? 1 : 0);
    this.state.speed = this.state.routeChoice === 'salt-cut' ? 34 : 26;
    this.state.battery = Math.min(this.state.maxBattery, this.state.battery + 8);
    this.state.objective =
      this.state.routeChoice === 'salt-cut'
        ? `Cross region ${this.state.region} before the electrical front overtakes the train.`
        : `Cross region ${this.state.region}; expect heavy boarders under forest cover.`;
    this.setMessage('The signal drops. The train returns to the ash.', 5);
    return true;
  }

  public pause(): void {
    if (this.state.mode === 'paused') {
      this.state.mode = this.state.previousMode === 'paused' ? 'travel' : this.state.previousMode;
      return;
    }
    if (this.state.mode === 'travel' || this.state.mode === 'station') {
      this.state.previousMode = this.state.mode;
      this.state.mode = 'paused';
    }
  }

  public save(): string {
    return serializeGameState(this.state);
  }

  public load(serialized: string): GameState {
    this.state = deserializeGameState(serialized);
    this.dodgeRemaining = 0;
    this.dodgeDirection = { x: 0, z: -1 };
    updatePowerDraw(this.state);
    return this.state;
  }

  public saveToStorage(storage: StorageLike, key = DEFAULT_SAVE_KEY): string {
    return saveGameToStorage(this.state, storage, key);
  }

  public loadFromStorage(storage: StorageLike, key = DEFAULT_SAVE_KEY): boolean {
    const loaded = loadGameFromStorage(storage, key);
    if (!loaded) return false;
    this.state = loaded;
    this.dodgeRemaining = 0;
    this.dodgeDirection = { x: 0, z: -1 };
    updatePowerDraw(this.state);
    return true;
  }

  public renderToText(): string {
    return buildRenderGameText(this.state);
  }

  private beginDodge(input: InputSnapshot): void {
    const player = this.state.player;
    if (player.dodgeCooldown > 0 || this.dodgeRemaining > 0 || this.state.mountedTurretActive) return;
    let forward = clamp(input.forward, -1, 1);
    let strafe = clamp(input.strafe, -1, 1);
    let magnitude = Math.hypot(forward, strafe);
    if (magnitude < 0.08) {
      forward = 1;
      strafe = 0;
      magnitude = 1;
    }
    forward /= magnitude;
    strafe /= magnitude;
    const yaw = player.yaw;
    this.dodgeDirection.x = -Math.sin(yaw) * forward + Math.cos(yaw) * strafe;
    this.dodgeDirection.z = -Math.cos(yaw) * forward - Math.sin(yaw) * strafe;
    this.dodgeRemaining = DODGE_DURATION;
    player.dodgeCooldown = DODGE_COOLDOWN;
    player.dodging = true;
    player.sprinting = false;
  }

  private tryAttack(events: GameplayEvents): void {
    const player = this.state.player;
    if (player.weaponCooldown > 0 || player.dodging || this.dodgeRemaining > 0) return;
    if (player.reloading) {
      if (player.ammo <= 0) return;
      player.reloading = false;
      player.reloadRemaining = 0;
    }
    if (player.equipment === 'sidearm' && player.ammo <= 0) {
      this.beginReload();
      return;
    }
    const attackEvents = this.attack();
    if (!attackEvents.shot) {
      player.weaponCooldown = 0.22;
      return;
    }
    Object.assign(events, attackEvents);
    const aimed = player.aiming;
    player.weaponCooldown = attackEvents.shot === 'sidearm'
      ? (aimed ? 0.145 : 0.19)
      : attackEvents.shot === 'arc-tool'
        ? 0.42
        : 0.48;
    player.recoil = Math.min(1, player.recoil + (attackEvents.shot === 'sidearm' ? (aimed ? 0.42 : 0.58) : attackEvents.shot === 'arc-tool' ? 0.32 : 0.18));
    player.shotSequence += 1;
    this.state.shake = Math.max(this.state.shake, attackEvents.shot === 'sidearm' ? 0.12 : 0.08);
  }

  private beginReload(): boolean {
    const player = this.state.player;
    if (
      player.equipment !== 'sidearm' ||
      player.reloading ||
      player.ammo >= 18 ||
      player.reserveAmmo <= 0 ||
      player.dodging
    ) return false;
    player.reloading = true;
    player.reloadRemaining = 1.12;
    player.weaponCooldown = Math.max(player.weaponCooldown, 1.12);
    player.recoil = 0;
    this.setMessage('K-12 magazine release.', 1.25);
    return true;
  }

  private applyPressedInput(input: InputSnapshot, events: GameplayEvents): void {
    if (this.state.mountedTurretActive) {
      this.state.turretYaw = clamp(
        this.state.turretYaw - input.cameraDeltaX * 0.0024,
        -TURRET_YAW_LIMIT,
        TURRET_YAW_LIMIT,
      );
      this.updateMountedTurretLock();
      if (input.interactPressed) this.dismountTurret();
      else if (input.primaryPressed) Object.assign(events, this.fireMountedTurret());
      return;
    }

    if (input.numberSelect >= 1 && input.numberSelect <= EQUIPMENT_ORDER.length) {
      this.selectEquipment(EQUIPMENT_ORDER[input.numberSelect - 1] ?? 'wrench');
    } else if (input.equipmentDelta !== 0) {
      this.cycleEquipment(input.equipmentDelta);
    }

    // Input snapshots report raw mouse pixels. The same authoritative yaw and
    // pitch drive movement, the camera sightline, reticle acquisition, and tracers.
    this.state.player.yaw = wrapAngle(this.state.player.yaw - input.cameraDeltaX * 0.0024);
    this.state.player.aimPitch = clamp(
      this.state.player.aimPitch - input.cameraDeltaY * 0.0019,
      CAMERA_PITCH_MIN,
      CAMERA_PITCH_MAX,
    );
    this.state.player.aiming = input.secondaryHeld;
    if (input.reloadPressed) this.beginReload();
    if (input.dodgePressed && this.state.mode === 'travel') this.beginDodge(input);
    if (input.primaryPressed) this.tryAttack(events);

    if (input.interactPressed && this.state.mode === 'travel') {
      const system = this.getContextualRepairTarget();
      if (system) {
        const result = this.performRepair(system);
        if (result.ok) events.systemChanged = system;
      } else if (this.isAtTurretStation()) {
        this.mountTurret();
      } else {
        const consoleSystem = this.getContextualSystemTarget();
        if (consoleSystem && consoleSystem !== 'turret') {
          this.toggleSystem(consoleSystem);
          events.systemChanged = consoleSystem;
        } else {
          const passenger = this.getContextualPassenger();
          if (passenger) this.checkInWithPassenger(passenger.id);
        }
      }
    }
  }

  private tickTravel(dt: number, input: InputSnapshot, events: GameplayEvents): void {
    const previousElapsed = this.state.elapsed;
    const previousRegionTime = this.state.regionTime;
    this.state.elapsed += dt;
    this.state.regionTime += dt;
    this.state.messageTimer = Math.max(0, this.state.messageTimer - dt);
    this.state.shake = Math.max(0, this.state.shake - dt * 1.8);
    this.state.player.aiming = this.state.mountedTurretActive || input.secondaryHeld;
    this.state.player.dodgeCooldown = Math.max(0, this.state.player.dodgeCooldown - dt);
    this.state.player.weaponCooldown = Math.max(0, this.state.player.weaponCooldown - dt);
    if (this.state.player.reloading) {
      this.state.player.reloadRemaining = Math.max(0, this.state.player.reloadRemaining - dt);
      if (this.state.player.reloadRemaining <= 0) {
        const rounds = Math.min(18 - this.state.player.ammo, this.state.player.reserveAmmo);
        this.state.player.ammo += rounds;
        this.state.player.reserveAmmo -= rounds;
        this.state.player.reloading = false;
        this.state.player.weaponCooldown = 0.08;
        this.setMessage(`K-12 ready · ${this.state.player.ammo} in the magazine.`, 1.5);
      }
    }
    this.state.player.recoil = moveToward(this.state.player.recoil, 0, dt * 7.5);
    this.state.turretCooldown = Math.max(0, this.state.turretCooldown - dt);

    this.movePlayer(dt, input);
    if (input.primaryHeld && this.state.player.weaponCooldown <= 0) this.tryAttack(events);
    tickBattery(this.state, dt);
    this.tickTrain(dt, previousElapsed);
    this.spawnScheduledWaves(previousRegionTime, this.state.regionTime);
    this.tickEnemies(dt, events);
    this.tickPassengers(dt, previousElapsed, events);
    if (this.state.mountedTurretActive) this.updateMountedTurretLock();

    this.state.enemies = this.state.enemies.filter(
      (enemy) => enemy.stage !== 'dead' || enemy.timer < 0.7,
    );
    this.state.alarm =
      this.state.enemies.some((enemy) => enemy.stage !== 'dead') ||
      Object.values(this.state.systems).some((system) => system.damaged) ||
      this.state.hull < 35;

    if (this.state.regionTime >= this.state.regionDuration) {
      if (this.reachStation()) events.stationReached = true;
      return;
    }
    if (this.state.hull <= 0) this.endGame('The train broke apart in the ash.', events);
    else if (this.state.player.health <= 0) this.endGame('You fell before the last car could be secured.', events);
    else if (this.state.fuel <= 0 && this.state.speed < 1) {
      this.endGame('The train coasted to a silent stop.', events);
    }
  }

  private movePlayer(dt: number, input: InputSnapshot): void {
    if (this.state.mountedTurretActive) {
      setPosition(this.state.player.position, TURRET_POSITION);
      setPosition(this.state.player.velocity, { x: 0, y: 0, z: 0 });
      this.state.player.carIndex = 3;
      this.state.player.sprinting = false;
      this.state.player.dodging = false;
      this.state.player.moveSpeed = 0;
      this.dodgeRemaining = 0;
      return;
    }
    let forward = clamp(input.forward, -1, 1);
    let strafe = clamp(input.strafe, -1, 1);
    const length = Math.hypot(forward, strafe);
    if (length > 1) {
      forward /= length;
      strafe /= length;
    }

    const yaw = this.state.player.yaw;
    const worldX = -Math.sin(yaw) * forward + Math.cos(yaw) * strafe;
    const worldZ = -Math.cos(yaw) * forward - Math.sin(yaw) * strafe;
    const moving = length > 0.001;
    const sprinting = input.sprint && forward > 0.25 && !this.state.player.aiming && this.dodgeRemaining <= 0;

    if (this.dodgeRemaining > 0) {
      const phase = this.dodgeRemaining / DODGE_DURATION;
      const dodgeSpeed = 7.4 + phase * 3.1;
      this.state.player.velocity.x = this.dodgeDirection.x * dodgeSpeed;
      this.state.player.velocity.z = this.dodgeDirection.z * dodgeSpeed;
      this.dodgeRemaining = Math.max(0, this.dodgeRemaining - dt);
    } else {
      const baseSpeed = this.state.player.aiming ? 3.15 : sprinting ? 7.05 : 4.65;
      const directionScale = forward < -0.05 ? 0.72 : Math.abs(strafe) > Math.abs(forward) ? 0.86 : 1;
      const targetX = moving ? worldX * baseSpeed * directionScale : 0;
      const targetZ = moving ? worldZ * baseSpeed * directionScale : 0;
      const current = this.state.player.velocity;
      const opposing = current.x * targetX + current.z * targetZ < -0.01;
      const response = moving ? (opposing ? 34 : sprinting ? 20 : this.state.player.aiming ? 28 : 24) : 31;
      moveVectorToward(current, targetX, targetZ, response * dt);
    }

    const dx = this.state.player.velocity.x * dt;
    const dz = this.state.player.velocity.z * dt;

    const desiredZ = this.state.player.position.z + dz;
    this.state.player.position.z = clamp(desiredZ, TRAIN_BOUNDS.minZ, TRAIN_BOUNDS.maxZ);
    if (this.state.player.position.z !== desiredZ) this.state.player.velocity.z = 0;
    const lateral = playerLateralBounds(this.state.player.position.z);
    const desiredX = this.state.player.position.x + dx;
    this.state.player.position.x = clamp(desiredX, lateral.minX, lateral.maxX);
    if (this.state.player.position.x !== desiredX) this.state.player.velocity.x = 0;
    this.state.player.position.y = 0;
    this.state.player.carIndex = carIndexForZ(this.state.player.position.z);
    this.state.player.sprinting = sprinting;
    this.state.player.dodging = this.dodgeRemaining > 0;
    this.state.player.moveSpeed = Math.hypot(this.state.player.velocity.x, this.state.player.velocity.z);
  }

  private tickTrain(dt: number, previousElapsed: number): void {
    const engine = this.state.systems.engine;
    const engineEfficiency = clamp(engine.health / 100, 0, 1);
    const routeSpeed =
      this.state.region <= 1 ? 0 : this.state.routeChoice === 'salt-cut' ? 4 : -4;
    const targetSpeed = engine.powered
      ? (61 + this.state.region * 1.5 + routeSpeed) * engineEfficiency
      : 0;
    const rate = this.state.speed < targetSpeed ? 7 : 10;
    this.state.speed = moveToward(this.state.speed, targetSpeed, rate * dt);
    this.state.fuel = Math.max(0, this.state.fuel - dt * (0.007 + this.state.speed * 0.00018));
    if (this.state.region > 1 && this.state.routeChoice === 'salt-cut') {
      this.state.battery = Math.max(0, this.state.battery - dt * 0.18);
    }

    const secondCrossed = Math.floor(previousElapsed) !== Math.floor(this.state.elapsed);
    if (!secondCrossed) return;

    if (!this.state.systems.cooling.powered || this.state.systems.cooling.health < 30) {
      applySystemDamage(this.state, 'engine', 1.2, 'overheat');
      const engineer = this.state.passengers.find((passenger) => passenger.id === 'mara-vale');
      if (engineer) engineer.morale = Math.max(0, engineer.morale - 0.7);
    }

    const moraleDelta = this.state.systems.lights.powered ? 0.08 : -0.22;
    for (const passenger of this.state.passengers) {
      passenger.morale = clamp(passenger.morale + moraleDelta, 0, 100);
    }

    // The repair tool recharges only when production has headroom.
    if (this.state.powerDraw < this.state.powerProduction) {
      this.state.player.toolCharge = Math.min(100, this.state.player.toolCharge + 2.5);
    }
  }

  private tickPassengers(dt: number, previousElapsed: number, events: GameplayEvents): void {
    const secondCrossed = Math.floor(previousElapsed) !== Math.floor(this.state.elapsed);
    this.tickMara(dt, secondCrossed);
    this.tickDoctor(dt);
    this.tickOren(dt, events);
  }

  private tickMara(dt: number, secondCrossed: boolean): void {
    const mara = this.findPassenger('mara-vale');
    if (!mara) return;
    if (mara.health <= 0) {
      mara.activity = 'sheltering';
      mara.targetSystem = undefined;
      return;
    }

    const targetSystem = Object.values(this.state.systems)
      .filter((system) => system.damaged)
      .sort((a, b) => a.health - b.health || b.priority - a.priority || a.id.localeCompare(b.id))[0];
    if (targetSystem) {
      mara.targetSystem = targetSystem.id;
      const arrived = this.movePassengerToward(mara, SYSTEM_POSITIONS[targetSystem.id], dt, 0.85);
      mara.activity = arrived ? 'repairing' : 'moving';
      if (arrived && secondCrossed) {
        const effectiveness = passengerEffectiveness(mara);
        targetSystem.health = Math.min(95, targetSystem.health + 1.8 * effectiveness);
      }
      return;
    }

    mara.targetSystem = undefined;
    this.movePassengerToDefault(mara, dt);
  }

  private tickDoctor(dt: number): void {
    const doctor = this.findPassenger('dr-ives');
    if (!doctor) return;
    if (doctor.health <= 0) {
      doctor.activity = 'sheltering';
      doctor.targetSystem = undefined;
      return;
    }

    const needsCare =
      this.state.player.health < this.state.player.maxHealth ||
      this.state.passengers.some((passenger) => passenger.health < 100);
    if (this.state.systems.medical.powered && (needsCare || this.state.alarm)) {
      doctor.targetSystem = 'medical';
      const arrived = this.movePassengerToward(doctor, SYSTEM_POSITIONS.medical, dt, 0.85);
      doctor.activity = arrived ? 'medical' : 'moving';
      if (arrived) {
        const effectiveness = passengerEffectiveness(doctor);
        const upgrade = this.hasUpgrade('medical-bunks') ? 2 : 1;
        this.state.player.health = Math.min(
          this.state.player.maxHealth,
          this.state.player.health + (0.35 + effectiveness * 1.05) * upgrade * dt,
        );
        for (const passenger of this.state.passengers) {
          passenger.health = Math.min(
            100,
            passenger.health + (0.2 + effectiveness * 0.72) * upgrade * dt,
          );
        }
      }
      return;
    }

    doctor.targetSystem = undefined;
    this.movePassengerToDefault(doctor, dt);
  }

  private tickOren(dt: number, events: GameplayEvents): void {
    const oren = this.findPassenger('oren-brass');
    if (!oren) return;
    if (oren.health <= 0) {
      oren.activity = 'sheltering';
      oren.targetSystem = undefined;
      this.state.turretAimAssist = false;
      if (!this.state.mountedTurretActive) this.state.turretOperator = null;
      return;
    }

    const turret = this.state.systems.turret;
    const assigned = this.state.alarm && turret.powered && !turret.damaged && turret.health > 20;
    if (!assigned) {
      oren.targetSystem = undefined;
      this.state.turretAimAssist = false;
      if (!this.state.mountedTurretActive) {
        this.state.turretOperator = null;
        this.state.turretTargetId = null;
      }
      this.movePassengerToDefault(oren, dt);
      return;
    }

    oren.targetSystem = 'turret';
    const arrived = this.movePassengerToward(oren, TURRET_POSITION, dt, 0.62);
    oren.activity = arrived ? 'turret' : 'moving';
    if (!arrived) {
      this.state.turretAimAssist = false;
      if (!this.state.mountedTurretActive) this.state.turretOperator = null;
      return;
    }

    const effectiveness = passengerEffectiveness(oren);
    if (this.state.mountedTurretActive) {
      this.state.turretOperator = 'player';
      this.state.turretAimAssist = effectiveness > 0.05;
      return;
    }

    this.state.turretOperator = 'oren';
    this.state.turretAimAssist = false;
    const desired = this.state.enemies
      .filter((enemy) => this.isRearTurretTarget(enemy))
      .sort((a, b) => this.turretTargetScore(a) - this.turretTargetScore(b) || a.id - b.id)[0];
    if (!desired) {
      this.state.turretTargetId = null;
      return;
    }
    const desiredYaw = clamp(
      Math.atan2(desired.position.x - TURRET_POSITION.x, desired.position.z - TURRET_POSITION.z),
      -TURRET_YAW_LIMIT,
      TURRET_YAW_LIMIT,
    );
    this.state.turretYaw = moveToward(
      this.state.turretYaw,
      desiredYaw,
      (0.42 + effectiveness * 1.5) * dt,
    );
    const target = this.selectTurretAimTarget(effectiveness * 0.45);
    this.state.turretTargetId = target?.id ?? null;
    if (target && this.state.turretCooldown <= 0) Object.assign(events, this.fireTurretAt(target));
  }

  private movePassengerToDefault(passenger: PassengerState, dt: number): void {
    const destination = this.state.alarm ? CREW_SHELTER : CREW_HOME[passenger.id];
    if (!destination) {
      passenger.activity = this.state.alarm ? 'sheltering' : 'idle';
      return;
    }
    const arrived = this.movePassengerToward(passenger, destination, dt);
    passenger.activity = arrived ? (this.state.alarm ? 'sheltering' : 'idle') : 'moving';
  }

  private movePassengerToward(
    passenger: PassengerState,
    target: { x: number; y: number; z: number },
    dt: number,
    arrivalDistance = 0.48,
  ): boolean {
    const finalDistance = Math.hypot(
      target.x - passenger.position.x,
      target.z - passenger.position.z,
    );
    if (finalDistance <= arrivalDistance) {
      setPosition(passenger.position, target);
      passenger.carIndex = carIndexForZ(passenger.position.z);
      return true;
    }

    const targetCar = carIndexForZ(target.z);
    const speed = 0.7 + passengerEffectiveness(passenger) * 1.75;
    let waypointX = target.x;
    let waypointZ = target.z;
    if (passenger.carIndex !== targetCar) {
      waypointX = 0;
      if (Math.abs(passenger.position.x) > 0.14) waypointZ = passenger.position.z;
    }
    const dx = waypointX - passenger.position.x;
    const dz = waypointZ - passenger.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 0.001) {
      const travel = Math.min(distance, speed * dt);
      passenger.position.x += (dx / distance) * travel;
      passenger.position.z += (dz / distance) * travel;
    }
    passenger.position.z = clamp(passenger.position.z, TRAIN_BOUNDS.minZ, TRAIN_BOUNDS.maxZ);
    const lateral = playerLateralBounds(passenger.position.z);
    passenger.position.x = clamp(passenger.position.x, lateral.minX, lateral.maxX);
    passenger.position.y = 0;
    passenger.carIndex = carIndexForZ(passenger.position.z);
    const remainingDistance = Math.hypot(
      target.x - passenger.position.x,
      target.z - passenger.position.z,
    );
    if (remainingDistance <= arrivalDistance) {
      setPosition(passenger.position, target);
      passenger.carIndex = carIndexForZ(passenger.position.z);
      return true;
    }
    return false;
  }

  private spawnScheduledWaves(previousTime: number, currentTime: number): void {
    const interval =
      this.state.region > 1 && this.state.routeChoice === 'dead-forest' ? 11.5 : WAVE_INTERVAL;
    const previousWave = Math.floor((previousTime + 4) / interval);
    const currentWave = Math.floor((currentTime + 4) / interval);
    for (let wave = previousWave + 1; wave <= currentWave; wave += 1) {
      this.spawnEnemy();
      const detectionPenalty = this.state.systems.lights.powered && wave % 2 === 0;
      const escalation = this.state.threatLevel >= 3 && wave % 3 === 0;
      if (detectionPenalty || escalation) this.spawnEnemy();
    }
  }

  private tickEnemies(dt: number, events: GameplayEvents): void {
    for (const enemy of this.state.enemies) {
      if (enemy.stage === 'dead') {
        enemy.timer += dt;
        continue;
      }
      if (enemy.hitStun > 0) {
        enemy.hitStun = Math.max(0, enemy.hitStun - dt);
        if (enemy.stage === 'inside') continue;
      }
      this.tickEnemy(enemy, dt, events);
    }
  }

  private tickEnemy(enemy: EnemyState, dt: number, events: GameplayEvents): void {
    const definition = ENEMY_DEFINITIONS[enemy.type];
    const attachment = attachmentPointById(enemy.attachmentPointId);
    if (!attachment) {
      enemy.stage = 'dead';
      enemy.timer = 0;
      return;
    }
    const previousTimer = enemy.timer;
    enemy.timer += dt;

    if (enemy.stage === 'approach') {
      const progress = clamp(enemy.timer / definition.approachTime, 0, 1);
      setLerpedPosition(enemy.position, attachment.approach, attachment.landing, smoothstep(progress));
      if (enemy.timer >= definition.approachTime) {
        enemy.timer -= definition.approachTime;
        enemy.stage = 'attached';
        setPosition(enemy.position, attachment.landing);
        this.state.shake = Math.max(this.state.shake, 0.32);
        this.setMessage(`${enemy.type} attached to car ${enemy.targetCar + 1}.`, 3);
      }
      return;
    }

    if (enemy.stage === 'attached') {
      const crawlProgress = clamp(enemy.timer / definition.attachTime, 0, 1);
      setLerpedPosition(enemy.position, attachment.landing, attachment.breach, smoothstep(crawlProgress));
      if (enemy.type === 'leeche') {
        this.state.battery = Math.max(0, this.state.battery - dt * 1.8);
      }
      if (
        enemy.type === 'ripper' &&
        Math.floor(previousTimer / 1.5) !== Math.floor(enemy.timer / 1.5)
      ) {
        this.enemyDamageSystem(enemy, 5);
      }
      if (enemy.timer >= definition.attachTime) {
        enemy.timer -= definition.attachTime;
        enemy.stage = 'breaching';
        setPosition(enemy.position, attachment.breach);
        this.setMessage(`Breach in progress: car ${enemy.targetCar + 1}.`, 3.5);
      }
      return;
    }

    if (enemy.stage === 'breaching') {
      if (enemy.type === 'leeche') this.state.battery = Math.max(0, this.state.battery - dt * 2.3);
      if (Math.floor(previousTimer / 1.8) !== Math.floor(enemy.timer / 1.8)) {
        this.enemyDamageSystem(enemy, enemy.type === 'ripper' ? 9 : 4);
        this.state.hull = Math.max(0, this.state.hull - (enemy.type === 'ripper' ? 2.5 : 1));
      }

      let breachTime = definition.breachTime;
      if (!this.state.systems.locks.powered) breachTime *= 0.48;
      if (this.hasUpgrade('reinforced-doors')) breachTime *= 1.45;
      const entryProgress = clamp(enemy.timer / breachTime, 0, 1);
      setLerpedPosition(enemy.position, attachment.breach, attachment.entry, smoothstep(entryProgress));
      if (enemy.timer >= breachTime) {
        enemy.timer -= breachTime;
        enemy.stage = 'inside';
        setPosition(enemy.position, attachment.entry);
        this.enemyDamageSystem(enemy, enemy.type === 'ripper' ? 18 : 10);
        this.state.hull = Math.max(0, this.state.hull - (enemy.type === 'ripper' ? 7 : 3));
        this.setMessage(`${enemy.type} is inside car ${enemy.targetCar + 1}!`, 4);
      }
      return;
    }

    if (enemy.stage === 'inside') {
      const dx = this.state.player.position.x - enemy.position.x;
      const dz = this.state.player.position.z - enemy.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > 0.001) {
        const travel = Math.min(distance, definition.insideSpeed * dt);
        enemy.position.x += (dx / distance) * travel;
        enemy.position.z += (dz / distance) * travel;
      }
      enemy.targetCar = carIndexForZ(enemy.position.z);
      const attackInterval = enemy.type === 'clinger' ? 0.9 : 1.25;
      if (
        distance < 1.45 &&
        Math.floor(previousTimer / attackInterval) !== Math.floor(enemy.timer / attackInterval)
      ) {
        const damage = this.state.player.dodging ? definition.contactDamage * 0.25 : definition.contactDamage;
        this.state.player.health = Math.max(0, this.state.player.health - damage);
        this.state.shake = Math.max(this.state.shake, damage / 24);
        events.impact = Math.max(events.impact ?? 0, damage / 20);
      }
    }
  }

  private enemyDamageSystem(enemy: EnemyState, amount: number): void {
    const id = attachmentPointById(enemy.attachmentPointId)?.targetSystem ?? 'locks';
    applySystemDamage(this.state, id, amount, DAMAGE_BY_ENEMY[enemy.type]);
  }

  private findCombatTarget(equipment: EquipmentId): EnemyState | undefined {
    const maxRange = equipment === 'wrench' ? 3.4 : equipment === 'arc-tool' ? 9 : 40;
    const halfAngleDegrees = equipment === 'wrench'
      ? 65
      : equipment === 'arc-tool'
        ? (this.state.player.aiming ? 7 : 11)
        : (this.state.player.aiming ? 4.8 : 8.5);
    const minimumAimDot = Math.cos((halfAngleDegrees * Math.PI) / 180);
    const yaw = this.state.player.yaw;
    const pitch = this.state.player.aimPitch;
    const pitchCos = Math.cos(pitch);
    const aimX = -Math.sin(yaw) * pitchCos;
    const aimY = Math.sin(pitch);
    const aimZ = -Math.cos(yaw) * pitchCos;
    const originY = this.state.player.position.y + 1.58;
    return this.state.enemies
      .filter((enemy) => enemy.stage !== 'dead')
      .map((enemy) => {
        const dx = enemy.position.x - this.state.player.position.x;
        const targetHeight = enemy.type === 'ripper' ? 1.15 : enemy.type === 'leeche' ? 0.72 : 0.82;
        const dy = enemy.position.y + targetHeight - originY;
        const dz = enemy.position.z - this.state.player.position.z;
        const distance = equipment === 'wrench' ? Math.hypot(dx, dz) : Math.hypot(dx, dy, dz);
        const aimDot = distance <= 0.001
          ? 1
          : equipment === 'wrench'
            ? (forwardFromYaw(yaw).x * dx + forwardFromYaw(yaw).z * dz) / Math.max(0.001, Math.hypot(dx, dz))
            : (aimX * dx + aimY * dy + aimZ * dz) / distance;
        return { enemy, distance, aimDot };
      })
      .filter(({ enemy, distance, aimDot }) => {
        if (distance > maxRange) return false;
        if (aimDot < minimumAimDot) return false;
        if (equipment === 'wrench') return enemy.stage === 'inside' || enemy.stage === 'breaching';
        return this.hasClearAttackLine(enemy);
      })
      .map((candidate) => ({
        ...candidate,
        score:
          (1 - candidate.aimDot) * maxRange * 18 +
          candidate.distance * 0.22 +
          Math.abs(candidate.enemy.targetCar - this.state.player.carIndex) * 3,
      }))
      .sort((a, b) => a.score - b.score || a.enemy.id - b.enemy.id)[0]?.enemy;
  }

  private hasClearAttackLine(enemy: EnemyState): boolean {
    if (enemy.stage === 'inside') {
      if (Math.abs(enemy.targetCar - this.state.player.carIndex) > 1) return false;
      // Between cars, only the central vestibule creates a plausible clear line.
      return (
        enemy.targetCar === this.state.player.carIndex ||
        (Math.abs(this.state.player.position.x) < 1.35 && Math.abs(enemy.position.x) < 1.35)
      );
    }

    // Exterior creatures are visible through the windows only on the player's
    // current car and current/central side; never target through the train body.
    return (
      enemy.targetCar === this.state.player.carIndex &&
      enemy.side * this.state.player.position.x >= -0.4
    );
  }

  private repairContextFailure(id: SystemId): 'out-of-range' | 'not-facing' | null {
    const position = SYSTEM_POSITIONS[id];
    const dx = position.x - this.state.player.position.x;
    const dz = position.z - this.state.player.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 2.35) return 'out-of-range';
    if (distance <= 0.25) return null;
    const forward = forwardFromYaw(this.state.player.yaw);
    const facingDot = (forward.x * dx + forward.z * dz) / distance;
    return facingDot >= 0.42 ? null : 'not-facing';
  }

  private updateMountedTurretLock(): void {
    const oren = this.findPassenger('oren-brass');
    const support = oren?.activity === 'turret' ? passengerEffectiveness(oren) : 0;
    this.state.turretAimAssist = support > 0.05;
    const target = this.selectTurretAimTarget(support);
    this.state.turretTargetId = target?.id ?? null;
  }

  private selectTurretAimTarget(assistStrength: number): EnemyState | undefined {
    const aimX = Math.sin(this.state.turretYaw);
    const aimZ = Math.cos(this.state.turretYaw);
    const halfAngle = ((6 + clamp(assistStrength, 0, 1) * 6) * Math.PI) / 180;
    const minimumDot = Math.cos(halfAngle);
    return this.state.enemies
      .filter((enemy) => this.isRearTurretTarget(enemy))
      .map((enemy) => {
        const dx = enemy.position.x - TURRET_POSITION.x;
        const dz = enemy.position.z - TURRET_POSITION.z;
        const distance = Math.hypot(dx, dz);
        const aimDot = distance > 0.001 ? (aimX * dx + aimZ * dz) / distance : -1;
        return { enemy, distance, aimDot };
      })
      .filter((candidate) => candidate.distance <= TURRET_MAX_RANGE && candidate.aimDot >= minimumDot)
      .sort(
        (a, b) =>
          (1 - a.aimDot) * 160 + a.distance - ((1 - b.aimDot) * 160 + b.distance) ||
          a.enemy.id - b.enemy.id,
      )[0]?.enemy;
  }

  private fireTurretAt(target: EnemyState): GameplayEvents {
    const oren = this.findPassenger('oren-brass');
    const support = oren?.activity === 'turret' ? passengerEffectiveness(oren) : 0;
    let damage = Math.round(68 * (0.9 + support * 0.35));
    if (this.hasUpgrade('turret-servos')) damage = Math.round(damage * 1.25);
    this.hitEnemy(target, damage);
    this.state.turretCooldown = 1.45 * (1.08 - support * 0.38);
    this.state.battery = Math.max(0, this.state.battery - 0.8);
    this.state.shake = Math.max(this.state.shake, 0.48);
    if (target.stage === 'dead') this.state.turretTargetId = null;
    return {
      turretFired: true,
      turretTargetId: target.id,
      enemyHit: { id: target.id, amount: damage },
      impact: 0.48,
    };
  }

  private findPassenger(id: string): PassengerState | undefined {
    return this.state.passengers.find((passenger) => passenger.id === id);
  }

  private isRearTurretTarget(enemy: EnemyState): boolean {
    if (enemy.stage === 'inside' || enemy.stage === 'dead') return false;
    const attachment = attachmentPointById(enemy.attachmentPointId);
    if (!attachment?.rearArc || attachment.carIndex !== 3) return false;
    const dx = enemy.position.x;
    const dz = enemy.position.z - 29;
    const distance = Math.hypot(dx, dz);
    return distance > 0.001 && distance <= TURRET_MAX_RANGE && dz / distance >= 0.15;
  }

  private turretTargetScore(enemy: EnemyState): number {
    const distance = Math.hypot(enemy.position.x, enemy.position.z - 29);
    const stagePriority = enemy.stage === 'breaching' ? 0 : enemy.stage === 'attached' ? 3 : 7;
    return stagePriority + distance + enemy.health * 0.015;
  }

  private hitEnemy(enemy: EnemyState, amount: number): void {
    enemy.health = Math.max(0, enemy.health - amount);
    enemy.hitStun = enemy.health > 0 ? 0.2 : 0;
    this.state.shake = Math.max(this.state.shake, Math.min(0.35, amount / 180));
    if (enemy.health > 0) return;
    enemy.stage = 'dead';
    enemy.timer = 0;
    this.state.scrap += enemy.type === 'ripper' ? 5 : enemy.type === 'leeche' ? 3 : 2;
    this.setMessage(`${enemy.type} repelled.`, 2.5);
  }

  private randomEnemyType(): EnemyType {
    const roll = this.random();
    const heavyRouteBonus =
      this.state.region > 1 && this.state.routeChoice === 'dead-forest' ? 0.18 : 0;
    const ripperThreshold = Math.min(
      0.62,
      0.13 + this.state.threatLevel * 0.045 + heavyRouteBonus,
    );
    if (roll < ripperThreshold) return 'ripper';
    if (roll < Math.min(0.86, ripperThreshold + 0.34)) return 'leeche';
    return 'clinger';
  }

  private random(): number {
    this.state.seed = (Math.imul(this.state.seed, 1_664_525) + 1_013_904_223) >>> 0;
    return this.state.seed / 0x1_0000_0000;
  }

  private hasUpgrade(id: string): boolean {
    return this.state.upgrades.some((upgrade) => upgrade.id === id && upgrade.purchased);
  }

  private endGame(reason: string, events: GameplayEvents): void {
    this.state.previousMode = 'travel';
    this.state.mode = 'gameover';
    this.state.speed = 0;
    this.state.mountedTurretActive = false;
    this.state.turretAimAssist = false;
    this.state.turretTargetId = null;
    this.state.turretOperator = null;
    this.state.gameOverReason = reason;
    this.state.objective = 'Run ended.';
    this.setMessage(reason, 20);
    events.gameOver = true;
  }

  private setMessage(message: string, seconds: number): void {
    this.state.message = message;
    this.state.messageTimer = seconds;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function setPosition(target: { x: number; y: number; z: number }, source: { x: number; y: number; z: number }): void {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
}

function setLerpedPosition(
  target: { x: number; y: number; z: number },
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  alpha: number,
): void {
  target.x = lerp(from.x, to.x, alpha);
  target.y = lerp(from.y, to.y, alpha);
  target.z = lerp(from.z, to.z, alpha);
}

function forwardFromYaw(yaw: number): { x: number; z: number } {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

function moveToward(value: number, target: number, maxDelta: number): number {
  if (value < target) return Math.min(target, value + maxDelta);
  return Math.max(target, value - maxDelta);
}

function moveVectorToward(
  current: { x: number; z: number },
  targetX: number,
  targetZ: number,
  maxDelta: number,
): void {
  const dx = targetX - current.x;
  const dz = targetZ - current.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= maxDelta || distance < 1e-6) {
    current.x = targetX;
    current.z = targetZ;
    return;
  }
  const scale = maxDelta / distance;
  current.x += dx * scale;
  current.z += dz * scale;
}

function wrapAngle(angle: number): number {
  const tau = Math.PI * 2;
  return ((angle + Math.PI) % tau + tau) % tau - Math.PI;
}
