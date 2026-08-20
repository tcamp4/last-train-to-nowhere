import { describe, expect, it } from 'vitest';
import {
  GameplaySimulation,
  TRAIN_BOUNDS,
  attachmentPointById,
  buildRenderGameText,
  deserializeGameState,
  passengerEffectiveness,
  playerLateralBounds,
  serializeGameState,
} from '../src/gameplay';

describe('GameplaySimulation power grid', () => {
  it('allocates limited power, uses the battery, and sheds low-priority circuits', () => {
    const game = new GameplaySimulation(11);
    game.startNewRun(11);

    expect(game.state.powerDraw).toBe(11);
    expect(game.toggleSystem('turret', true)).toBe(true);
    expect(game.state.powerDraw).toBe(16);

    const batteryBefore = game.state.battery;
    game.update(2);
    expect(game.state.battery).toBeCloseTo(batteryBefore - 8, 4);

    game.state.battery = 0;
    game.update(1 / 60);
    expect(game.state.powerDraw).toBeLessThanOrEqual(game.state.powerProduction);
    expect(game.state.systems.turret.powered).toBe(false);
    expect(game.state.systems.engine.powered).toBe(true);
  });

  it('makes an unpowered cooling circuit damage the engine', () => {
    const game = new GameplaySimulation(12);
    game.startNewRun(12);
    game.toggleSystem('cooling', false);
    game.update(1.1);

    expect(game.state.systems.engine.health).toBeLessThan(100);
    expect(game.state.systems.engine.damageKind).toBe('overheat');
  });

  it('lets the player operate a healthy system from its physical console', () => {
    const game = new GameplaySimulation(13);
    game.startNewRun(13);
    game.state.player.position = { x: -1.1, y: 0, z: -25 };
    game.state.player.yaw = Math.PI / 2;

    expect(game.getContextualSystemTarget()).toBe('radar');
    const events = game.update(1 / 60, { interactPressed: true });

    expect(events.systemChanged).toBe('radar');
    expect(game.state.systems.radar.powered).toBe(true);
    expect(game.state.message).toContain('power routed');
  });

  it('lets the player check in with physical crew during travel', () => {
    const game = new GameplaySimulation(14);
    game.startNewRun(14);
    game.state.player.position = { x: 0.9, y: 0, z: -6.5 };
    game.state.player.yaw = -Math.PI / 2;

    expect(game.getContextualPassenger()?.id).toBe('mara-vale');
    game.update(1 / 60, { interactPressed: true });

    expect(game.state.message).toContain('Mara Vale:');
  });
});

describe('movement, equipment, and combat', () => {
  it('starts with the ranged sidearm drawn and can shoot a same-car exterior boarder', () => {
    const game = new GameplaySimulation(20);
    game.startNewRun(20);
    expect(game.state.player.equipment).toBe('sidearm');

    const enemy = game.spawnEnemy('clinger', 1, 1);
    enemy.stage = 'attached';
    enemy.position = { x: 3.72, y: 2, z: -10 };
    const dx = enemy.position.x - game.state.player.position.x;
    const dz = enemy.position.z - game.state.player.position.z;
    game.state.player.yaw = Math.atan2(-dx, -dz);
    game.state.player.aimPitch = Math.atan2(
      enemy.position.y + 0.82 - (game.state.player.position.y + 1.58),
      Math.hypot(dx, dz),
    );

    expect(game.getHandheldCombatTarget()?.id).toBe(enemy.id);
    const event = game.attack();
    expect(event.enemyHit).toEqual({ id: enemy.id, amount: 34 });
    expect(enemy.health).toBe(28);
  });

  it('moves continuously between all four cars while respecting train bounds', () => {
    const game = new GameplaySimulation(21);
    game.startNewRun(21);
    expect(game.state.player.position.z).toBe(-9);
    expect(game.state.player.carIndex).toBe(1);

    game.update(10, { forward: 1, sprint: true });
    expect(game.state.player.position.z).toBe(TRAIN_BOUNDS.minZ);
    expect(game.state.player.carIndex).toBe(0);

    game.state.player.yaw = Math.PI;
    game.update(20, { forward: 1, sprint: true });
    expect(game.state.player.position.z).toBe(TRAIN_BOUNDS.maxZ);
    expect(game.state.player.carIndex).toBe(3);

    game.state.player.yaw = Math.PI / 2;
    game.update(2, { forward: 1, sprint: true });
    expect(game.state.player.position.x).toBe(playerLateralBounds(game.state.player.position.z).minX);
  });

  it('accelerates and brakes responsively instead of teleporting to full speed', () => {
    const game = new GameplaySimulation(25);
    game.startNewRun(25);

    game.update(1 / 60, { forward: 1 });
    expect(game.state.player.moveSpeed).toBeGreaterThan(0.25);
    expect(game.state.player.moveSpeed).toBeLessThan(1);

    game.update(0.3, { forward: 1 });
    expect(game.state.player.moveSpeed).toBeCloseTo(4.65, 1);
    const movingZ = game.state.player.position.z;
    game.update(0.2);
    expect(game.state.player.moveSpeed).toBe(0);
    expect(game.state.player.position.z).toBeLessThan(movingZ);
  });

  it('commits a directional dodge with recovery and invulnerability state', () => {
    const game = new GameplaySimulation(26);
    game.startNewRun(26);
    const startX = game.state.player.position.x;

    game.update(0.08, { strafe: 1, dodgePressed: true });
    expect(game.state.player.dodging).toBe(true);
    expect(game.state.player.position.x).toBeGreaterThan(startX + 0.5);
    expect(game.state.player.dodgeCooldown).toBeGreaterThan(0.5);

    game.update(0.24);
    expect(game.state.player.dodging).toBe(false);
    const cooldown = game.state.player.dodgeCooldown;
    game.update(1 / 60, { forward: 1, dodgePressed: true });
    expect(game.state.player.dodging).toBe(false);
    expect(game.state.player.dodgeCooldown).toBeLessThan(cooldown);
  });

  it('keeps the player capsule in fitted aisles and centers traversal at gangways', () => {
    const game = new GameplaySimulation(24);
    game.startNewRun(24);
    game.state.player.position = { x: 2.8, y: 0, z: -18.2 };
    game.state.player.yaw = Math.PI;
    game.update(0.1, { forward: 1 });
    expect(Math.abs(game.state.player.position.x)).toBeLessThanOrEqual(1.02);
    expect(game.state.player.position.z).toBeGreaterThan(-18.2);
  });

  it('switches equipment and applies deterministic weapon damage', () => {
    const game = new GameplaySimulation(22);
    game.startNewRun(22);
    const enemy = game.spawnEnemy('leeche', 1, 1);
    enemy.stage = 'inside';
    enemy.position = { x: 0, y: 0, z: -13 };
    game.state.player.aiming = true;
    game.state.player.aimPitch = Math.atan2(0.72 - 1.58, 4);

    game.selectEquipment('arc-tool');
    const event = game.attack();
    expect(event.enemyHit).toEqual({ id: enemy.id, amount: 70 });
    expect(enemy.health).toBe(8);
    expect(game.state.player.toolCharge).toBe(88);

    game.update(0.01, { equipmentDelta: -1 });
    expect(game.state.player.equipment).toBe('sidearm');
    game.attack();
    expect(enemy.stage).toBe('dead');
  });

  it('fires the K-12 at a controlled held-trigger cadence with reticle-accurate pitch', () => {
    const game = new GameplaySimulation(27);
    game.startNewRun(27);
    const enemy = game.spawnEnemy('ripper', 1, 1);
    enemy.stage = 'inside';
    enemy.position = { x: 0, y: 0, z: -15 };
    game.state.player.aimPitch = Math.atan2(1.15 - 1.58, 6);

    game.update(0.5, { primaryHeld: true, secondaryHeld: true });

    expect(game.state.player.ammo).toBe(14);
    expect(enemy.health).toBe(9);
    expect(game.state.player.shotSequence).toBe(4);
    expect(game.state.player.recoil).toBeGreaterThan(0);
  });

  it('reloads a partial K-12 magazine from a persistent reserve', () => {
    const game = new GameplaySimulation(29);
    game.startNewRun(29);
    game.state.player.ammo = 3;
    game.state.player.reserveAmmo = 20;

    game.update(1 / 60, { reloadPressed: true });
    expect(game.state.player.reloading).toBe(true);
    expect(game.state.player.reloadRemaining).toBeGreaterThan(1);
    game.update(1.2);

    expect(game.state.player.reloading).toBe(false);
    expect(game.state.player.ammo).toBe(18);
    expect(game.state.player.reserveAmmo).toBe(5);
  });

  it('does not magnetize shots to enemies outside the actual 3D reticle cone', () => {
    const game = new GameplaySimulation(28);
    game.startNewRun(28);
    game.state.player.aiming = true;
    const low = game.spawnEnemy('clinger', 1, 1);
    low.stage = 'inside';
    low.position = { x: 0, y: 0, z: -15 };
    const high = game.spawnEnemy('clinger', 1, -1);
    high.stage = 'inside';
    high.position = { x: 0, y: 2.4, z: -15 };
    game.state.player.aimPitch = Math.atan2(high.position.y + 0.82 - 1.58, 6);

    expect(game.getHandheldCombatTarget()?.id).toBe(high.id);
    game.attack();
    expect(high.health).toBe(28);
    expect(low.health).toBe(62);
  });

  it('only attacks within the player-facing field of view and favors a clear aim line', () => {
    const game = new GameplaySimulation(24);
    game.startNewRun(24);
    game.selectEquipment('sidearm');
    game.state.player.yaw = 0;

    const behind = game.spawnEnemy('clinger', 1, 1);
    behind.stage = 'inside';
    behind.position = { x: 0, y: 0, z: -5 };
    const centered = game.spawnEnemy('clinger', 1, -1);
    centered.stage = 'inside';
    centered.position = { x: 0, y: 0, z: -15 };
    const closerPeripheral = game.spawnEnemy('clinger', 1, 1);
    closerPeripheral.stage = 'inside';
    closerPeripheral.position = { x: 1.5, y: 0, z: -11.6 };
    const occludedExterior = game.spawnEnemy('clinger', 0, -1);
    occludedExterior.stage = 'attached';
    occludedExterior.position = { x: 0, y: 1, z: -12 };

    const event = game.attack();

    expect(event.enemyHit?.id).toBe(centered.id);
    expect(centered.health).toBe(28);
    expect(behind.health).toBe(62);
    expect(closerPeripheral.health).toBe(62);
    expect(occludedExterior.health).toBe(62);
  });

  it('mounts, aims, fires, and exits the powered rear turret manually', () => {
    const game = new GameplaySimulation(23);
    game.startNewRun(23);
    game.toggleSystem('turret', true);
    game.state.player.position.z = 29;
    game.state.player.carIndex = 3;
    const ineligible = game.spawnEnemy('ripper', 0, -1, 'car-0-left-rear-seam');
    const enemy = game.spawnEnemy('ripper', 3, -1, 'car-3-left-rear-seam');
    const battery = game.state.battery;

    const mountEvent = game.update(1 / 60, { interactPressed: true });
    expect(mountEvent.enemyHit).toBeUndefined();
    expect(game.state.mountedTurretActive).toBe(true);
    const mountedPosition = { ...game.state.player.position };
    game.update(0.2, { forward: 1, strafe: 1 });
    expect(game.state.player.position).toEqual(mountedPosition);

    const desiredYaw = Math.atan2(enemy.position.x, enemy.position.z - 29);
    game.update(1 / 60, { cameraDeltaX: -desiredYaw / 0.0024 });
    expect(game.state.turretTargetId).toBe(enemy.id);
    const event = game.update(1 / 60, { primaryPressed: true });

    expect(event.turretFired).toBe(true);
    expect(event.turretTargetId).toBe(enemy.id);
    expect(event.shot).toBeUndefined();
    expect(enemy.health).toBeLessThan(145);
    expect(ineligible.health).toBe(145);
    expect(game.state.battery).toBeLessThan(battery);
    expect(game.state.turretCooldown).toBeGreaterThan(0);

    game.update(1 / 60, { interactPressed: true });
    expect(game.state.mountedTurretActive).toBe(false);
  });
});

describe('damage and interactive repairs', () => {
  it('requires the correct ordered tools for every repair step', () => {
    const game = new GameplaySimulation(31);
    game.startNewRun(31);
    game.damageSystem('radar', 45, 'electrical');

    expect(game.getRepairPrompt('radar')?.id).toBe('isolate-circuit');
    expect(game.performRepair('radar').reason).toBe('out-of-range');
    game.state.player.position = { x: -1.8, y: 0, z: -23.5 };
    game.state.player.yaw = Math.PI;
    expect(game.getContextualRepairTarget()).toBeNull();
    expect(game.performRepair('radar').reason).toBe('not-facing');
    game.state.player.yaw = 0;
    expect(game.getContextualRepairTarget()).toBe('radar');
    expect(game.performRepair('radar').reason).toBe('wrong-equipment');

    game.selectEquipment('arc-tool');
    expect(game.performRepair('radar', 'replace-fuse').reason).toBe('wrong-step');
    expect(game.performRepair('radar', 'isolate-circuit').ok).toBe(true);
    expect(game.state.systems.radar.repairProgress).toBeCloseTo(100 / 3);

    game.selectEquipment('wrench');
    expect(game.performRepair('radar', 'replace-fuse').ok).toBe(true);
    game.selectEquipment('arc-tool');
    const completed = game.performRepair('radar', 'restart-system');

    expect(completed).toEqual({ ok: true, completed: true });
    expect(game.state.systems.radar.damaged).toBe(false);
    expect(game.state.systems.radar.health).toBe(72);
    expect(game.state.systems.radar.repairProgress).toBe(0);
  });

  it('propagates major cooling damage into the engine', () => {
    const game = new GameplaySimulation(32);
    game.startNewRun(32);
    game.damageSystem('cooling', 40, 'breach');
    expect(game.state.systems.cooling.health).toBe(60);
    expect(game.state.systems.engine.health).toBe(94);
  });

  it('has Mara physically reach faults and scale repair quality with crew condition', () => {
    const assisted = new GameplaySimulation(33);
    assisted.startNewRun(33);
    assisted.damageSystem('cooling', 40, 'breach');
    const mara = assisted.state.passengers.find((passenger) => passenger.id === 'mara-vale')!;
    const damagedHealth = assisted.state.systems.cooling.health;

    assisted.update(2.3);
    expect(mara.activity).toBe('repairing');
    expect(mara.targetSystem).toBe('cooling');
    expect(mara.position.z).toBeCloseTo(-10, 1);
    expect(assisted.state.systems.cooling.health).toBeGreaterThan(damagedHealth);

    assisted.state.player.position = { x: 1.9, y: 0, z: -8.5 };
    assisted.state.player.yaw = 0;
    assisted.performRepair('cooling', 'clean-edge');
    assisted.selectEquipment('arc-tool');
    assisted.performRepair('cooling', 'weld-seam');
    assisted.selectEquipment('wrench');
    assisted.performRepair('cooling', 'pressure-test');
    const assistedHealth = assisted.state.systems.cooling.health;

    const struggling = new GameplaySimulation(34);
    struggling.startNewRun(34);
    struggling.damageSystem('cooling', 40, 'breach');
    const weakMara = struggling.state.passengers.find((passenger) => passenger.id === 'mara-vale')!;
    weakMara.health = 20;
    weakMara.morale = 0;
    weakMara.loyalty = 0;
    weakMara.position = { x: 1.9, y: 0, z: -10 };
    weakMara.activity = 'repairing';
    weakMara.targetSystem = 'cooling';
    struggling.state.player.position = { x: 1.9, y: 0, z: -8.5 };
    struggling.state.player.yaw = 0;
    struggling.performRepair('cooling', 'clean-edge');
    struggling.selectEquipment('arc-tool');
    struggling.performRepair('cooling', 'weld-seam');
    struggling.selectEquipment('wrench');
    struggling.performRepair('cooling', 'pressure-test');

    expect(passengerEffectiveness(mara)).toBeGreaterThan(passengerEffectiveness(weakMara));
    expect(assistedHealth).toBeGreaterThan(struggling.state.systems.cooling.health);
  });
});

describe('passenger agency and turret crew', () => {
  it('has Dr. Ives move to powered medical equipment and scale healing with condition', () => {
    const active = new GameplaySimulation(35);
    active.startNewRun(35);
    active.toggleSystem('medical', true);
    active.state.player.health = 50;
    const doctor = active.state.passengers.find((passenger) => passenger.id === 'dr-ives')!;
    expect(doctor.position.z).toBe(6);
    active.update(4);
    expect(doctor.activity).toBe('medical');
    expect(doctor.position.z).toBeCloseTo(12, 1);
    expect(active.state.player.health).toBeGreaterThan(50);

    const healthyCrew = new GameplaySimulation(36);
    const weakCrew = new GameplaySimulation(36);
    for (const game of [healthyCrew, weakCrew]) {
      game.startNewRun(36);
      game.toggleSystem('medical', true);
      game.state.player.health = 50;
      const crewDoctor = game.state.passengers.find((passenger) => passenger.id === 'dr-ives')!;
      crewDoctor.position = { x: -1.8, y: 0, z: 12 };
    }
    const strongDoctor = healthyCrew.state.passengers.find((passenger) => passenger.id === 'dr-ives')!;
    strongDoctor.health = strongDoctor.morale = strongDoctor.loyalty = 100;
    const weakDoctor = weakCrew.state.passengers.find((passenger) => passenger.id === 'dr-ives')!;
    weakDoctor.health = 20;
    weakDoctor.morale = 0;
    weakDoctor.loyalty = 0;
    healthyCrew.update(1.1);
    weakCrew.update(1.1);
    expect(healthyCrew.state.player.health - 50).toBeGreaterThan(weakCrew.state.player.health - 50);
  });

  it('has Oren move to alarms, operate the turret, and scale assist, damage, and reload', () => {
    const autonomous = new GameplaySimulation(37);
    autonomous.startNewRun(37);
    autonomous.toggleSystem('turret', true);
    autonomous.spawnEnemy('ripper', 3, -1, 'car-3-left-rear-seam');
    const oren = autonomous.state.passengers.find((passenger) => passenger.id === 'oren-brass')!;
    const initialZ = oren.position.z;
    const autoEvent = autonomous.update(4);
    expect(oren.position.z).toBeGreaterThan(initialZ);
    expect(oren.activity).toBe('turret');
    expect(autonomous.state.turretOperator).toBe('oren');
    expect(autoEvent.turretFired).toBe(true);

    const runShot = (strong: boolean) => {
      const game = new GameplaySimulation(strong ? 38 : 39);
      game.startNewRun(strong ? 38 : 39);
      game.toggleSystem('turret', true);
      game.state.player.position = { x: 0, y: 0, z: 29 };
      game.state.player.carIndex = 3;
      const target = game.spawnEnemy('ripper', 3, -1, 'car-3-left-rear-seam');
      const gunner = game.state.passengers.find((passenger) => passenger.id === 'oren-brass')!;
      gunner.position = { x: 0, y: 0, z: 29 };
      gunner.health = strong ? 100 : 20;
      gunner.morale = strong ? 100 : 0;
      gunner.loyalty = strong ? 100 : 0;
      game.update(1 / 60, { interactPressed: true });
      const desiredYaw = Math.atan2(target.position.x, target.position.z - 29);
      game.update(1 / 60, { cameraDeltaX: -desiredYaw / 0.0024 });
      const event = game.update(1 / 60, { primaryPressed: true });
      return { game, event };
    };

    const strong = runShot(true);
    const weak = runShot(false);
    expect(strong.game.state.turretAimAssist).toBe(true);
    expect(weak.game.state.turretAimAssist).toBe(false);
    expect(strong.event.enemyHit!.amount).toBeGreaterThan(weak.event.enemyHit!.amount);
    expect(strong.game.state.turretCooldown).toBeLessThan(weak.game.state.turretCooldown);
  });

  it('offers two consequential authored crew briefings and prevents station farming', () => {
    const ids = ['mara-vale', 'dr-ives', 'oren-brass'];
    for (const id of ids) {
      const supported = new GameplaySimulation(40);
      supported.startNewRun(40);
      supported.reachStation();
      const support = supported.talkToPassenger(id, 'support');
      expect(support.ok).toBe(true);
      expect(support.text.length).toBeGreaterThan(20);
      expect(support.loyaltyDelta).not.toBe(0);
      expect(supported.talkToPassenger(id, 'challenge').reason).toBe('already-briefed');

      const challenged = new GameplaySimulation(40);
      challenged.startNewRun(40);
      challenged.reachStation();
      const challenge = challenged.talkToPassenger(id, 'challenge');
      expect(challenge.ok).toBe(true);
      expect(challenge.text).not.toBe(support.text);
      expect([challenge.loyaltyDelta, challenge.moraleDelta]).not.toEqual([
        support.loyaltyDelta,
        support.moraleDelta,
      ]);
    }
  });
});

describe('enemy boarding state machines', () => {
  it('approaches, physically attaches, breaches, and enters through unpowered locks', () => {
    const game = new GameplaySimulation(41);
    game.startNewRun(41);
    game.toggleSystem('locks', false);
    const point = attachmentPointById('car-2-right-forward-seam')!;
    const enemy = game.spawnEnemy('clinger', 2, 1, point.id);

    expect(enemy.position).toEqual(point.approach);

    game.update(2.21);
    expect(enemy.stage).toBe('attached');
    expect(enemy.position.x).toBeCloseTo(point.landing.x, 1);
    expect(enemy.position.z).toBeCloseTo(point.landing.z, 1);

    game.update(0.7);
    expect(enemy.stage).toBe('attached');
    expect(enemy.position.z).toBeLessThan(point.landing.z);
    expect(enemy.position.z).toBeGreaterThan(point.breach.z);

    game.update(0.71);
    expect(enemy.stage).toBe('breaching');

    game.update(1.7);
    expect(enemy.stage).toBe('inside');
    expect(enemy.position.x).toBeLessThan(point.breach.x);
    expect(enemy.position.z).toBeCloseTo(point.entry.z, 0);
    expect(enemy.position.z).not.toBeCloseTo(9);
    expect(game.state.hull).toBeLessThan(100);
    expect(Object.values(game.state.systems).some((system) => system.damaged)).toBe(true);
  });

  it('spawns deterministic seeded waves and lets leeches drain the battery outside', () => {
    const first = new GameplaySimulation(42);
    const second = new GameplaySimulation(42);
    first.startNewRun(42);
    second.startNewRun(42);

    first.update(10.05);
    second.update(10.05);
    expect(first.state.enemies).toEqual(second.state.enemies);
    expect(first.state.enemies.length).toBeGreaterThan(0);
    expect(first.state.enemies.every((enemy) => enemy.position.x !== 0)).toBe(true);

    const leechGame = new GameplaySimulation(43);
    leechGame.startNewRun(43);
    const leech = leechGame.spawnEnemy('leeche', 1, -1);
    leechGame.update(3.2);
    expect(leech.stage).toBe('attached');
    const battery = leechGame.state.battery;
    leechGame.update(1);
    expect(leechGame.state.battery).toBeLessThan(battery);
  });
});

describe('stations and world progression', () => {
  it('reaches a station, installs an upgrade, takes the deal, and departs harder', () => {
    const game = new GameplaySimulation(51);
    game.startNewRun(51);
    game.state.regionDuration = 0.2;
    const events = game.update(0.25);

    expect(events.stationReached).toBe(true);
    expect(game.state.mode).toBe('station');
    expect(game.state.stationVisits).toBe(1);

    const production = game.state.powerProduction;
    expect(game.purchaseUpgrade('generator-coils')).toBe(true);
    expect(game.state.powerProduction).toBe(production + 3);
    expect(game.purchaseUpgrade('generator-coils')).toBe(false);

    const fuel = game.state.fuel;
    expect(game.acceptStationDeal()).toBe(true);
    expect(game.state.fuel).toBeGreaterThan(fuel);
    expect(game.acceptStationDeal()).toBe(false);

    expect(game.chooseRoute('dead-forest')).toBe(true);

    expect(game.departStation()).toBe(true);
    expect(game.state.mode).toBe('travel');
    expect(game.state.region).toBe(2);
    expect(game.state.regionTime).toBe(0);
    expect(game.state.threatLevel).toBeGreaterThan(1);
    expect(game.state.routeChoice).toBe('dead-forest');
    expect(game.state.regionDuration).toBe(91);
  });

  it('applies distinct persistent Salt Cut and Dead Forest route modifiers', () => {
    const salt = new GameplaySimulation(52);
    const forest = new GameplaySimulation(52);
    salt.startNewRun(52);
    forest.startNewRun(52);
    salt.reachStation();
    forest.reachStation();
    salt.chooseRoute('salt-cut');
    forest.chooseRoute('dead-forest');
    salt.departStation();
    forest.departStation();

    expect(salt.state.regionDuration).toBe(71);
    expect(forest.state.regionDuration).toBe(91);
    expect(salt.state.threatLevel).toBe(forest.state.threatLevel + 1);
    const saltBattery = salt.state.battery;
    const forestBattery = forest.state.battery;
    salt.update(1);
    forest.update(1);
    expect(salt.state.battery - saltBattery).toBeLessThan(forest.state.battery - forestBattery);

    const persisted = deserializeGameState(serializeGameState(forest.state));
    const loaded = new GameplaySimulation(persisted);
    expect(persisted.routeChoice).toBe('dead-forest');
    expect(loaded.state.routeChoice).toBe('dead-forest');
  });
});

describe('persistence and automation text', () => {
  it('round-trips all authoritative state and resumes seeded progression', () => {
    const original = new GameplaySimulation(61);
    original.startNewRun(61);
    original.toggleSystem('radar', true);
    original.spawnEnemy('ripper', 3, -1);
    original.update(1.25, { forward: 1 });

    const serialized = serializeGameState(original.state);
    const rawLoaded = deserializeGameState(serialized);
    expect(rawLoaded).toEqual(original.state);

    const resumed = new GameplaySimulation(999);
    resumed.load(serialized);
    original.update(4);
    resumed.update(4);
    expect(resumed.state).toEqual(original.state);
  });

  it('persists mounted-turret and crew agency state while hydrating legacy saves', () => {
    const game = new GameplaySimulation(63);
    game.startNewRun(63);
    game.toggleSystem('turret', true);
    game.state.player.position = { x: 0, y: 0, z: 29 };
    game.update(1 / 60, { interactPressed: true });
    game.update(1 / 60, { cameraDeltaX: -125 });
    const mara = game.state.passengers.find((passenger) => passenger.id === 'mara-vale')!;
    mara.activity = 'repairing';
    mara.targetSystem = 'cooling';
    mara.position = { x: 1.9, y: 0, z: -10 };

    const persisted = deserializeGameState(serializeGameState(game.state));
    expect(persisted.mountedTurretActive).toBe(true);
    expect(persisted.turretYaw).not.toBe(0);
    expect(persisted.turretOperator).toBe('player');
    expect(persisted.passengers.find((passenger) => passenger.id === 'mara-vale')).toMatchObject({
      activity: 'repairing',
      targetSystem: 'cooling',
      position: { x: 1.9, y: 0, z: -10 },
    });

    const legacyEnvelope = JSON.parse(serializeGameState(game.state)) as Record<string, any>;
    delete legacyEnvelope.state.mountedTurretActive;
    delete legacyEnvelope.state.turretYaw;
    delete legacyEnvelope.state.turretCooldown;
    delete legacyEnvelope.state.turretAimAssist;
    delete legacyEnvelope.state.turretTargetId;
    delete legacyEnvelope.state.turretOperator;
    for (const passenger of legacyEnvelope.state.passengers) {
      delete passenger.position;
      delete passenger.carIndex;
      delete passenger.activity;
      delete passenger.lastBriefingVisit;
    }
    const legacy = deserializeGameState(JSON.stringify(legacyEnvelope));
    expect(legacy.mountedTurretActive).toBe(false);
    expect(legacy.turretYaw).toBe(0);
    expect(legacy.turretOperator).toBe(null);
    expect(legacy.passengers.every((passenger) => passenger.activity === 'idle')).toBe(true);
    expect(legacy.passengers.every((passenger) => Number.isFinite(passenger.position.z))).toBe(true);
  });

  it('builds a succinct, coordinate-aware render_game_to_text payload', () => {
    const game = new GameplaySimulation(62);
    game.startNewRun(62);
    game.spawnEnemy('clinger', 0, 1);
    const payload = JSON.parse(buildRenderGameText(game.state)) as Record<string, any>;

    expect(payload.coordinates).toContain('-Z toward locomotive');
    expect(payload.mode).toBe('travel');
    expect(payload.player.car).toBe(1);
    expect(payload.enemies).toHaveLength(1);
    expect(payload.systems).toHaveLength(7);
    expect(JSON.stringify(payload).length).toBeLessThan(2000);
  });
});
