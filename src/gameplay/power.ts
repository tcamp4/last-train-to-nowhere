import type { GameState, SystemId } from '../shared/types';

export const BATTERY_BURST_LIMIT = 4;

export function availablePower(state: GameState): number {
  return state.powerProduction + (state.battery > 0.001 ? BATTERY_BURST_LIMIT : 0);
}

export function calculatePowerDraw(state: GameState): number {
  let draw = 0;
  for (const system of Object.values(state.systems)) {
    if (system.powered && system.health > 0) draw += system.draw;
  }
  return draw;
}

export function updatePowerDraw(state: GameState): void {
  state.powerDraw = calculatePowerDraw(state);
}

/**
 * Sheds the least important powered circuits until demand fits. Higher numeric
 * priorities are protected. The circuit just requested by the player is shed last.
 */
export function enforcePowerCapacity(state: GameState, protectedId?: SystemId): SystemId[] {
  const shed: SystemId[] = [];
  let draw = calculatePowerDraw(state);
  const capacity = availablePower(state);

  const candidates = Object.values(state.systems)
    .filter((system) => system.powered && system.id !== protectedId)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const protectedSystem = protectedId ? state.systems[protectedId] : undefined;
  if (protectedSystem?.powered) candidates.push(protectedSystem);

  for (const system of candidates) {
    if (draw <= capacity) break;
    system.powered = false;
    draw -= system.draw;
    shed.push(system.id);
  }

  state.powerDraw = Math.max(0, draw);
  return shed;
}

export function setSystemPowered(state: GameState, id: SystemId, powered: boolean): boolean {
  const system = state.systems[id];
  if (powered && system.health <= 0) return false;
  system.powered = powered;
  const shed = enforcePowerCapacity(state, powered ? id : undefined);
  return system.powered && !shed.includes(id);
}

export function tickBattery(state: GameState, dt: number): void {
  updatePowerDraw(state);
  const balance = state.powerProduction - state.powerDraw;
  if (balance < 0) {
    state.battery = Math.max(0, state.battery + balance * dt);
    if (state.battery === 0) enforcePowerCapacity(state);
  } else if (balance > 0) {
    state.battery = Math.min(state.maxBattery, state.battery + balance * 0.42 * dt);
  }
}

