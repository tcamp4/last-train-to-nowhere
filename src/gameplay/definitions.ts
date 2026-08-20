import type {
  DamageKind,
  EnemyType,
  EquipmentId,
  PassengerState,
  RouteChoice,
  SystemId,
  TrainSystemState,
  UpgradeState,
  Vec3Data,
} from '../shared/types';

export const TRAIN_BOUNDS = Object.freeze({
  minX: -3.05,
  maxX: 3.05,
  minZ: -35,
  maxZ: 35,
});

/** Locomotive, engineering, passenger, and defense car centers. */
export const CAR_CENTERS = Object.freeze([-27, -9, 9, 27] as const);

export interface LateralBounds { minX: number; maxX: number }

/** Capsule-safe walkable aisle width, narrowed at each flexible gangway. */
export function playerLateralBounds(z: number): LateralBounds {
  if ([-18, 0, 18].some((doorZ) => Math.abs(z - doorZ) < 1.15)) {
    return { minX: -1.02, maxX: 1.02 };
  }
  const car = carIndexForZ(z);
  const fittedAisles: readonly LateralBounds[] = [
    { minX: -1.35, maxX: 1.35 },
    { minX: -0.72, maxX: 1.25 },
    { minX: -1.15, maxX: 1.15 },
    { minX: -1.42, maxX: 1.42 },
  ];
  return fittedAisles[car] ?? { minX: -1.1, maxX: 1.1 };
}

export const ROUTE_CHOICES: readonly RouteChoice[] = Object.freeze(['salt-cut', 'dead-forest']);

export const SYSTEM_CARS: Readonly<Record<SystemId, number>> = Object.freeze({
  engine: 0,
  radar: 0,
  cooling: 1,
  lights: 2,
  locks: 2,
  medical: 2,
  turret: 3,
});

export const SYSTEM_POSITIONS: Readonly<Record<SystemId, Vec3Data>> = Object.freeze({
  engine: { x: 1.9, y: 0, z: -30 },
  radar: { x: -1.8, y: 0, z: -25 },
  cooling: { x: 1.9, y: 0, z: -10 },
  lights: { x: -1.9, y: 0, z: 5 },
  locks: { x: 1.9, y: 0, z: 12 },
  medical: { x: -1.8, y: 0, z: 12 },
  turret: { x: 0, y: 0, z: 29 },
});

export interface ExteriorAttachmentPoint {
  id: string;
  carIndex: number;
  side: -1 | 1;
  approach: Vec3Data;
  landing: Vec3Data;
  breach: Vec3Data;
  entry: Vec3Data;
  targetSystem: SystemId;
  rearArc: boolean;
}

const ATTACHMENT_SYSTEMS: readonly (readonly [SystemId, SystemId])[] = [
  ['engine', 'radar'],
  ['cooling', 'cooling'],
  ['locks', 'medical'],
  ['turret', 'turret'],
];

/**
 * Authored boarding anchors on both sides of every car. Each anchor describes
 * the complete exterior route: leap origin -> roof/armor landing -> breach seam
 * -> interior entry point. Presentation follows these authoritative positions.
 */
export const EXTERIOR_ATTACHMENT_POINTS: readonly ExteriorAttachmentPoint[] = Object.freeze(
  CAR_CENTERS.flatMap((centerZ, carIndex) =>
    ([-1, 1] as const).flatMap((side) =>
      ([-1, 1] as const).map((slot, slotIndex) => {
        const breachZ = centerZ + slot * 5.2;
        const label = side < 0 ? 'left' : 'right';
        const seam = slot < 0 ? 'forward-seam' : 'rear-seam';
        return Object.freeze({
          id: `car-${carIndex}-${label}-${seam}`,
          carIndex,
          side,
          approach: { x: side * 10.5, y: 2.4, z: breachZ + 5.6 },
          landing: { x: side * 3.86, y: 3.75, z: breachZ + 2.8 },
          breach: { x: side * 3.64, y: 1.35, z: breachZ },
          entry: { x: side * 2.72, y: 0, z: breachZ },
          targetSystem: ATTACHMENT_SYSTEMS[carIndex]?.[slotIndex] ?? 'locks',
          rearArc: carIndex === 3 && slot > 0,
        });
      }),
    ),
  ),
);

export function attachmentPointById(id: string): ExteriorAttachmentPoint | undefined {
  return EXTERIOR_ATTACHMENT_POINTS.find((point) => point.id === id);
}

export function attachmentPointsFor(
  carIndex: number,
  side?: -1 | 1,
): readonly ExteriorAttachmentPoint[] {
  return EXTERIOR_ATTACHMENT_POINTS.filter(
    (point) => point.carIndex === carIndex && (side === undefined || point.side === side),
  );
}

export interface EnemyDefinition {
  health: number;
  approachTime: number;
  attachTime: number;
  breachTime: number;
  insideSpeed: number;
  contactDamage: number;
}

export const ENEMY_DEFINITIONS: Readonly<Record<EnemyType, EnemyDefinition>> = Object.freeze({
  clinger: {
    health: 62,
    approachTime: 2.2,
    attachTime: 1.4,
    breachTime: 3.4,
    insideSpeed: 3.4,
    contactDamage: 8,
  },
  leeche: {
    health: 78,
    approachTime: 3.1,
    attachTime: 2.2,
    breachTime: 5,
    insideSpeed: 2.2,
    contactDamage: 5,
  },
  ripper: {
    health: 145,
    approachTime: 4.2,
    attachTime: 2.8,
    breachTime: 6.4,
    insideSpeed: 1.45,
    contactDamage: 14,
  },
});

export const EQUIPMENT_ORDER: readonly EquipmentId[] = Object.freeze([
  'wrench',
  'sidearm',
  'arc-tool',
]);

export interface RepairStepDefinition {
  id: string;
  label: string;
  equipment: EquipmentId;
}

export const REPAIR_SEQUENCES: Readonly<Record<DamageKind, readonly RepairStepDefinition[]>> =
  Object.freeze({
    electrical: [
      { id: 'isolate-circuit', label: 'Isolate live circuit', equipment: 'arc-tool' },
      { id: 'replace-fuse', label: 'Replace burned fuse', equipment: 'wrench' },
      { id: 'restart-system', label: 'Pulse the starter', equipment: 'arc-tool' },
    ],
    overheat: [
      { id: 'vent-pressure', label: 'Vent pressure valve', equipment: 'wrench' },
      { id: 'cool-components', label: 'Quench hot components', equipment: 'arc-tool' },
      { id: 'restart-system', label: 'Restart the pump', equipment: 'wrench' },
    ],
    jam: [
      { id: 'open-housing', label: 'Open weapon housing', equipment: 'wrench' },
      { id: 'clear-jam', label: 'Clear the feed jam', equipment: 'wrench' },
      { id: 'realign', label: 'Realign the feed tray', equipment: 'arc-tool' },
    ],
    breach: [
      { id: 'clean-edge', label: 'Clean the torn edge', equipment: 'wrench' },
      { id: 'weld-seam', label: 'Weld the breach shut', equipment: 'arc-tool' },
      { id: 'pressure-test', label: 'Pressure-test the seam', equipment: 'wrench' },
    ],
    fire: [
      { id: 'suppress-flame', label: 'Suppress the flames', equipment: 'arc-tool' },
      { id: 'replace-wiring', label: 'Replace scorched wiring', equipment: 'wrench' },
      { id: 'restart-system', label: 'Restart the circuit', equipment: 'arc-tool' },
    ],
  });

export function createSystems(): Record<SystemId, TrainSystemState> {
  return {
    engine: system('engine', 'Drive motors', 4, 10, true),
    lights: system('lights', 'Interior & search lights', 2, 4, true),
    locks: system('locks', 'Door locks', 2, 8, true),
    radar: system('radar', 'Track radar', 3, 5, false),
    turret: system('turret', 'Rear turret', 5, 6, false),
    medical: system('medical', 'Medical bay', 3, 2, false),
    cooling: system('cooling', 'Cooling pumps', 3, 9, true),
  };
}

function system(
  id: SystemId,
  label: string,
  draw: number,
  priority: number,
  powered: boolean,
): TrainSystemState {
  return {
    id,
    label,
    draw,
    priority,
    powered,
    health: 100,
    damaged: false,
    repairProgress: 0,
  };
}

export function createPassengers(): PassengerState[] {
  return [
    {
      id: 'mara-vale',
      name: 'Mara Vale',
      profession: 'Engineer',
      ability: 'Field repairs restore systems to 85% health.',
      weakness: 'Loses morale while cooling is offline.',
      morale: 72,
      health: 100,
      loyalty: 58,
      position: { x: 1.8, y: 0, z: -6.5 },
      carIndex: 1,
      activity: 'idle',
      lastBriefingVisit: -1,
    },
    {
      id: 'dr-ives',
      name: 'Dr. Ives',
      profession: 'Doctor',
      ability: 'Powered medical equipment slowly heals the crew.',
      weakness: 'Refuses questionable experiments.',
      morale: 66,
      health: 92,
      loyalty: 52,
      position: { x: -1.8, y: 0, z: 6 },
      carIndex: 2,
      activity: 'idle',
      lastBriefingVisit: -1,
    },
    {
      id: 'oren-brass',
      name: 'Oren Brass',
      profession: 'Gunner',
      ability: 'The rear turret fires more accurately.',
      weakness: 'Consumes extra supplies at stations.',
      morale: 61,
      health: 100,
      loyalty: 44,
      position: { x: 1.8, y: 0, z: 24 },
      carIndex: 3,
      activity: 'idle',
      lastBriefingVisit: -1,
    },
  ];
}

export function createUpgrades(): UpgradeState[] {
  return [
    upgrade('generator-coils', 'Overwound Generator Coils', 'Adds 3 power production.', 18),
    upgrade('battery-bank', 'Salvaged Battery Bank', 'Adds 30 battery capacity.', 16),
    upgrade('reinforced-doors', 'Reinforced Vestibules', 'Boarders take longer to breach locks.', 20),
    upgrade('turret-servos', 'Recoil-Damped Servos', 'The powered turret deals more damage.', 22),
    upgrade('repair-rig', 'Induction Repair Rig', 'Repairs restore more system health.', 14),
    upgrade('medical-bunks', 'Field-Surgery Bunks', 'The medical system heals twice as fast.', 15),
  ];
}

function upgrade(id: string, label: string, description: string, cost: number): UpgradeState {
  return { id, label, description, cost, purchased: false };
}

export function carIndexForZ(z: number): number {
  if (z < -18) return 0;
  if (z < 0) return 1;
  if (z < 18) return 2;
  return 3;
}

export function carCenter(carIndex: number): number {
  return CAR_CENTERS[Math.max(0, Math.min(3, Math.trunc(carIndex)))] ?? CAR_CENTERS[0];
}
