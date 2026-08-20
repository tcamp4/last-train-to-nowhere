import type { GameMode, GameState, SystemId } from '../shared/types';
import { cloneGameState, hydrateGameState } from './state';

export const SAVE_VERSION = 1;
export const DEFAULT_SAVE_KEY = 'last-train-to-nowhere.save.v1';

const SYSTEM_IDS: readonly SystemId[] = [
  'engine',
  'lights',
  'locks',
  'radar',
  'turret',
  'medical',
  'cooling',
];
const GAME_MODES: readonly GameMode[] = ['title', 'travel', 'station', 'paused', 'gameover'];

export interface SaveEnvelope {
  version: number;
  savedAt: string;
  state: GameState;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function serializeGameState(state: GameState): string {
  const envelope: SaveEnvelope = {
    version: SAVE_VERSION,
    savedAt: new Date(0).toISOString(),
    state: cloneGameState(state),
  };
  return JSON.stringify(envelope);
}

export function deserializeGameState(serialized: string): GameState {
  let data: unknown;
  try {
    data = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error('Save data is not valid JSON.');
  }

  if (!isRecord(data) || data.version !== SAVE_VERSION || !isRecord(data.state)) {
    throw new Error('Save data is missing or uses an unsupported version.');
  }
  const state = data.state as unknown as GameState;
  validateState(state);
  return hydrateGameState(state);
}

export function saveGameToStorage(
  state: GameState,
  storage: StorageLike,
  key = DEFAULT_SAVE_KEY,
): string {
  const serialized = serializeGameState(state);
  storage.setItem(key, serialized);
  return serialized;
}

export function loadGameFromStorage(
  storage: StorageLike,
  key = DEFAULT_SAVE_KEY,
): GameState | null {
  const serialized = storage.getItem(key);
  return serialized === null ? null : deserializeGameState(serialized);
}

function validateState(state: GameState): void {
  if (!isRecord(state) || !GAME_MODES.includes(state.mode)) throw new Error('Invalid game mode.');
  if (!isFiniteNumber(state.seed) || !isFiniteNumber(state.elapsed)) {
    throw new Error('Invalid simulation clock.');
  }
  if (!isRecord(state.player) || !isRecord(state.player.position)) {
    throw new Error('Invalid player state.');
  }
  if (!isRecord(state.systems) || SYSTEM_IDS.some((id) => !isRecord(state.systems[id]))) {
    throw new Error('Invalid train systems.');
  }
  if (!Array.isArray(state.enemies) || !Array.isArray(state.passengers) || !Array.isArray(state.upgrades)) {
    throw new Error('Invalid entity data.');
  }

  const criticalNumbers = [
    state.regionTime,
    state.regionDuration,
    state.region,
    state.speed,
    state.hull,
    state.fuel,
    state.scrap,
    state.powerProduction,
    state.battery,
    state.maxBattery,
    state.player.position.x,
    state.player.position.y,
    state.player.position.z,
    state.player.health,
  ];
  if (criticalNumbers.some((value) => !isFiniteNumber(value))) {
    throw new Error('Save data contains invalid numeric state.');
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
