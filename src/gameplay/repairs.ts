import type { DamageKind, EquipmentId, GameState, SystemId } from '../shared/types';
import { REPAIR_SEQUENCES, type RepairStepDefinition } from './definitions';
import { passengerEffectiveness } from './passengers';
import { updatePowerDraw } from './power';

const DEFAULT_DAMAGE: Readonly<Record<SystemId, DamageKind>> = Object.freeze({
  engine: 'overheat',
  lights: 'electrical',
  locks: 'breach',
  radar: 'electrical',
  turret: 'jam',
  medical: 'electrical',
  cooling: 'overheat',
});

export interface RepairPrompt extends RepairStepDefinition {
  systemId: SystemId;
  index: number;
  total: number;
  progress: number;
}

export interface RepairResult {
  ok: boolean;
  completed: boolean;
  reason?: 'not-damaged' | 'wrong-step' | 'wrong-equipment' | 'out-of-range' | 'not-facing';
  prompt?: RepairPrompt;
}

export function applySystemDamage(
  state: GameState,
  id: SystemId,
  amount: number,
  kind: DamageKind = DEFAULT_DAMAGE[id],
): number {
  const system = state.systems[id];
  const actual = Math.max(0, Math.min(system.health, amount));
  if (actual <= 0) return 0;

  system.health = Math.max(0, system.health - actual);
  system.damaged = true;
  system.damageKind = kind;
  system.repairProgress = 0;
  if (system.health <= 0) system.powered = false;

  // Failed cooling cooks the drive circuitry; this is the slice's explicit
  // damage-propagation path and makes power decisions mechanically connected.
  if (id === 'cooling' && actual >= 10) {
    const engine = state.systems.engine;
    const propagated = actual * 0.15;
    engine.health = Math.max(0, engine.health - propagated);
    if (engine.health < 70) {
      engine.damaged = true;
      engine.damageKind = 'overheat';
    }
    if (engine.health <= 0) engine.powered = false;
  }

  updatePowerDraw(state);
  return actual;
}

export function getRepairPrompt(state: GameState, id: SystemId): RepairPrompt | null {
  const system = state.systems[id];
  if (!system.damaged || !system.damageKind) return null;
  const sequence = REPAIR_SEQUENCES[system.damageKind];
  const index = Math.min(
    sequence.length - 1,
    Math.floor((system.repairProgress / 100) * sequence.length + 1e-6),
  );
  const step = sequence[index];
  if (!step) return null;
  return {
    ...step,
    systemId: id,
    index,
    total: sequence.length,
    progress: system.repairProgress,
  };
}

export function performRepairStep(
  state: GameState,
  id: SystemId,
  equipment: EquipmentId,
  requestedStep?: string,
): RepairResult {
  const prompt = getRepairPrompt(state, id);
  if (!prompt) return { ok: false, completed: false, reason: 'not-damaged' };
  if (requestedStep !== undefined && requestedStep !== prompt.id) {
    return { ok: false, completed: false, reason: 'wrong-step', prompt };
  }
  if (equipment !== prompt.equipment) {
    return { ok: false, completed: false, reason: 'wrong-equipment', prompt };
  }

  const system = state.systems[id];
  const nextIndex = prompt.index + 1;
  if (nextIndex < prompt.total) {
    system.repairProgress = (nextIndex / prompt.total) * 100;
    return { ok: true, completed: false, prompt: getRepairPrompt(state, id) ?? undefined };
  }

  const engineer = state.passengers.find((passenger) => passenger.id === 'mara-vale');
  const engineerContribution =
    engineer?.activity === 'repairing' && engineer.targetSystem === id
      ? passengerEffectiveness(engineer)
      : 0;
  const hasRig = state.upgrades.some((upgrade) => upgrade.id === 'repair-rig' && upgrade.purchased);
  system.health = Math.max(system.health, hasRig ? 100 : 72 + engineerContribution * 28);
  system.damaged = false;
  system.damageKind = undefined;
  system.repairProgress = 0;
  updatePowerDraw(state);
  return { ok: true, completed: true };
}
