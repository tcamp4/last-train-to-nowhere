export type GameMode = 'title' | 'travel' | 'station' | 'paused' | 'gameover';
export type SystemId = 'engine' | 'lights' | 'locks' | 'radar' | 'turret' | 'medical' | 'cooling';
export type DamageKind = 'electrical' | 'overheat' | 'jam' | 'breach' | 'fire';
export type EnemyType = 'clinger' | 'leeche' | 'ripper';
export type EnemyStage = 'approach' | 'attached' | 'breaching' | 'inside' | 'dead';
export type EquipmentId = 'wrench' | 'sidearm' | 'arc-tool';
export type RouteChoice = 'salt-cut' | 'dead-forest';
export type PassengerActivity = 'idle' | 'moving' | 'repairing' | 'medical' | 'turret' | 'sheltering';
export type PassengerConversationChoice = 'support' | 'challenge';
export type TurretOperator = 'player' | 'oren' | null;

export interface Vec3Data { x: number; y: number; z: number }

export interface TrainSystemState {
  id: SystemId;
  label: string;
  draw: number;
  priority: number;
  powered: boolean;
  health: number;
  damaged: boolean;
  damageKind?: DamageKind;
  repairProgress: number;
}

export interface PlayerState {
  position: Vec3Data;
  velocity: Vec3Data;
  yaw: number;
  aimPitch: number;
  health: number;
  maxHealth: number;
  carIndex: number;
  equipment: EquipmentId;
  ammo: number;
  reserveAmmo: number;
  toolCharge: number;
  sprinting: boolean;
  dodging: boolean;
  aiming: boolean;
  moveSpeed: number;
  dodgeCooldown: number;
  weaponCooldown: number;
  reloadRemaining: number;
  reloading: boolean;
  recoil: number;
  shotSequence: number;
}

export interface EnemyState {
  id: number;
  type: EnemyType;
  stage: EnemyStage;
  health: number;
  position: Vec3Data;
  targetCar: number;
  side: -1 | 1;
  attachmentPointId: string;
  timer: number;
  hitStun: number;
}

export interface PassengerState {
  id: string;
  name: string;
  profession: string;
  ability: string;
  weakness: string;
  morale: number;
  health: number;
  loyalty: number;
  position: Vec3Data;
  carIndex: number;
  activity: PassengerActivity;
  targetSystem?: SystemId;
  lastBriefingVisit: number;
}

export interface UpgradeState {
  id: string;
  label: string;
  description: string;
  cost: number;
  purchased: boolean;
}

export interface GameState {
  mode: GameMode;
  previousMode: GameMode;
  seed: number;
  elapsed: number;
  regionTime: number;
  regionDuration: number;
  region: number;
  stationName: string;
  objective: string;
  threatLevel: number;
  speed: number;
  hull: number;
  fuel: number;
  scrap: number;
  powerProduction: number;
  battery: number;
  maxBattery: number;
  powerDraw: number;
  alarm: boolean;
  weather: 'ash-storm';
  player: PlayerState;
  systems: Record<SystemId, TrainSystemState>;
  enemies: EnemyState[];
  passengers: PassengerState[];
  upgrades: UpgradeState[];
  nextEnemyId: number;
  stationVisits: number;
  dealTaken: boolean;
  routeChoice: RouteChoice;
  mountedTurretActive: boolean;
  turretYaw: number;
  turretCooldown: number;
  turretAimAssist: boolean;
  turretTargetId: number | null;
  turretOperator: TurretOperator;
  message: string;
  messageTimer: number;
  shake: number;
  gameOverReason: string;
  debug: boolean;
}

export interface InputSnapshot {
  forward: number;
  strafe: number;
  sprint: boolean;
  dodgePressed: boolean;
  reloadPressed: boolean;
  interactPressed: boolean;
  primaryPressed: boolean;
  primaryHeld: boolean;
  secondaryHeld: boolean;
  tabPressed: boolean;
  pausePressed: boolean;
  equipmentDelta: number;
  numberSelect: number;
  cameraDeltaX: number;
  cameraDeltaY: number;
}

export interface GameplayEvents {
  systemChanged?: SystemId;
  enemyHit?: { id: number; amount: number };
  shot?: EquipmentId;
  turretFired?: boolean;
  turretTargetId?: number;
  impact?: number;
  stationReached?: boolean;
  gameOver?: boolean;
}

export interface QualitySettings {
  preset: 'low' | 'medium' | 'high' | 'ultra';
  shadows: boolean;
  particles: number;
  resolutionScale: number;
}
