import type { GameState } from '../shared/types';

/** Concise, player-relevant state for deterministic browser automation. */
export function buildRenderGameText(state: GameState): string {
  const payload = {
    coordinates: 'train-local; origin center; +X right, +Y up, -Z toward locomotive',
    mode: state.mode,
    objective: state.objective,
    region: {
      number: state.region,
      timeRemaining: round(Math.max(0, state.regionDuration - state.regionTime)),
      threat: state.threatLevel,
      station: state.stationName,
      route: state.routeChoice,
    },
    train: {
      speed: round(state.speed),
      hull: round(state.hull),
      fuel: round(state.fuel),
      power: `${round(state.powerDraw)}/${round(state.powerProduction)}`,
      battery: round(state.battery),
      alarm: state.alarm,
    },
    player: {
      x: round(state.player.position.x),
      y: round(state.player.position.y),
      z: round(state.player.position.z),
      car: state.player.carIndex,
      yaw: round(state.player.yaw),
      pitch: round(state.player.aimPitch),
      velocity: {
        x: round(state.player.velocity.x),
        z: round(state.player.velocity.z),
        speed: round(state.player.moveSpeed),
      },
      health: round(state.player.health),
      equipment: state.player.equipment,
      aiming: state.player.aiming,
      ammo: state.player.ammo,
      reserveAmmo: state.player.reserveAmmo,
      reloading: state.player.reloading,
      reloadRemaining: round(state.player.reloadRemaining),
      charge: round(state.player.toolCharge),
      sprinting: state.player.sprinting,
      dodging: state.player.dodging,
      dodgeCooldown: round(state.player.dodgeCooldown),
      weaponCooldown: round(state.player.weaponCooldown),
      recoil: round(state.player.recoil),
    },
    turret: {
      mounted: state.mountedTurretActive,
      yaw: round(state.turretYaw),
      cooldown: round(state.turretCooldown),
      assist: state.turretAimAssist,
      target: state.turretTargetId,
      operator: state.turretOperator,
    },
    systems: Object.values(state.systems).map((system) => ({
      id: system.id,
      on: system.powered,
      hp: round(system.health),
      damage: system.damageKind ?? null,
      repair: round(system.repairProgress),
    })),
    enemies: state.enemies
      .filter((enemy) => enemy.stage !== 'dead')
      .map((enemy) => ({
        id: enemy.id,
        type: enemy.type,
        stage: enemy.stage,
        hp: round(enemy.health),
        car: enemy.targetCar,
        side: enemy.side,
        attachment: enemy.attachmentPointId,
        x: round(enemy.position.x),
        z: round(enemy.position.z),
      })),
    crew: state.passengers.map((passenger) => ({
      id: passenger.id,
      x: round(passenger.position.x),
      z: round(passenger.position.z),
      car: passenger.carIndex,
      activity: passenger.activity,
      target: passenger.targetSystem ?? null,
      hp: round(passenger.health),
      morale: round(passenger.morale),
      loyalty: round(passenger.loyalty),
    })),
    station:
      state.mode === 'station'
        ? {
            scrap: state.scrap,
            upgrades: state.upgrades
              .filter((upgrade) => !upgrade.purchased)
              .map((upgrade) => ({ id: upgrade.id, cost: upgrade.cost })),
            dealAvailable: !state.dealTaken,
          }
        : undefined,
    message: state.messageTimer > 0 ? state.message : undefined,
    gameOverReason: state.mode === 'gameover' ? state.gameOverReason : undefined,
  };
  return JSON.stringify(payload);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
