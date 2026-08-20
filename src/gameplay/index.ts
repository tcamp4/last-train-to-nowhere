export { GameplaySimulation, EMPTY_INPUT } from './simulation';
export { createInitialGameState, cloneGameState, hydrateGameState, DEFAULT_SEED } from './state';
export {
  TRAIN_BOUNDS,
  CAR_CENTERS,
  SYSTEM_CARS,
  SYSTEM_POSITIONS,
  ENEMY_DEFINITIONS,
  EQUIPMENT_ORDER,
  REPAIR_SEQUENCES,
  ROUTE_CHOICES,
  EXTERIOR_ATTACHMENT_POINTS,
  attachmentPointById,
  attachmentPointsFor,
  playerLateralBounds,
  type ExteriorAttachmentPoint,
  carCenter,
  carIndexForZ,
} from './definitions';
export {
  availablePower,
  calculatePowerDraw,
  enforcePowerCapacity,
  setSystemPowered,
  updatePowerDraw,
} from './power';
export {
  applySystemDamage,
  getRepairPrompt,
  performRepairStep,
  type RepairPrompt,
  type RepairResult,
} from './repairs';
export {
  DEFAULT_SAVE_KEY,
  SAVE_VERSION,
  deserializeGameState,
  loadGameFromStorage,
  saveGameToStorage,
  serializeGameState,
  type SaveEnvelope,
  type StorageLike,
} from './persistence';
export { buildRenderGameText } from './text';
export {
  passengerEffectiveness,
  talkToPassenger,
  type PassengerConversationResult,
} from './passengers';
