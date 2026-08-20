import './styles.css';
import { TrainAudio } from './audio';
import { DebugPanel } from './DebugPanel';
import { InputController } from './InputController';
import { GameplaySimulation, SYSTEM_CARS, SYSTEM_POSITIONS } from './gameplay';
import { TrainScene } from './scene';
import type { GameState, GameplayEvents, InputSnapshot, QualitySettings, SystemId, Vec3Data } from './shared/types';
import { GameUI } from './ui';
import type { NavigationReadout, PassengerBriefingChoice, TurretReadout } from './ui';

const SAVE_KEY = 'last-train-to-nowhere:save';
const QUALITY_KEY = 'last-train-to-nowhere:quality';

const appRoot = document.querySelector<HTMLElement>('#app');
if (!appRoot) throw new Error('Missing #app root');
const app: HTMLElement = appRoot;

const canvas = document.createElement('canvas');
canvas.id = 'game-canvas';
canvas.setAttribute('aria-label', 'Third-person view inside the Last Train');
canvas.tabIndex = 0;
app.append(canvas);

const storedQuality = readQuality();
const simulation = new GameplaySimulation();
const scene = new TrainScene(canvas, storedQuality);
const input = new InputController(canvas);
let powerOpen = false;
let enemiesRepelled = 0;
let repairsCompleted = 0;
let lastEnemyCount = 0;
const audio: TrainAudio = new TrainAudio();

interface NavigationTarget extends NavigationReadout {
  position: Vec3Data;
}

const ui = new GameUI(app, {
  onStart: () => {
    simulation.startNewRun(randomSeed());
    resetRunStats();
    startPlay();
  },
  onContinue: () => {
    if (!safeLoad()) simulation.startNewRun(randomSeed());
    if (simulation.state.mode === 'paused') simulation.pause();
    if (simulation.state.mode === 'title' || simulation.state.mode === 'gameover') simulation.state.mode = 'travel';
    if (simulation.state.player.equipment === 'wrench') {
      simulation.state.message = 'Press 2 to draw the K-12 · hold RMB to aim · LMB to fire.';
      simulation.state.messageTimer = 5;
    }
    startPlay();
  },
  onToggleSystem: (id, powered) => {
    simulation.toggleSystem(id, powered);
    syncPresentation(0);
  },
  onClosePower: () => closePowerPanel(),
  onRepairTrain: () => {
    if (!simulation.repairTrainAtStation()) ui.showAlert('The platform crew needs 12 salvage and visible damage.', 'warning');
    syncPresentation(0);
  },
  onBuyUpgrade: (id) => {
    if (!simulation.purchaseUpgrade(id)) ui.showAlert('That fitting cannot be installed.', 'warning');
    syncPresentation(0);
  },
  onPassengerChoice: (id, choice) => reviewPassenger(id, choice),
  onDeal: (accepted) => {
    if (accepted) simulation.acceptStationDeal();
    else {
      simulation.state.message = 'The porter withdraws the black canister without a word.';
      simulation.state.messageTimer = 4;
    }
    syncPresentation(0);
  },
  onChooseRoute: (route) => {
    simulation.chooseRoute(route);
    syncPresentation(0);
  },
  onDepart: () => {
    simulation.departStation();
    powerOpen = false;
    startPlay();
  },
  onResume: () => {
    simulation.pause();
    startPlay();
  },
  onQualityChange: (preset) => {
    scene.setQuality(preset);
    try { localStorage.setItem(QUALITY_KEY, preset); } catch { /* private mode */ }
  },
  onSaveAndQuit: () => {
    safeSave();
    simulation.state.previousMode = simulation.state.mode;
    simulation.state.mode = 'title';
    powerOpen = false;
    input.setEnabled(false);
    if (document.pointerLockElement) void document.exitPointerLock();
    ui.setContinueAvailable(true);
    syncPresentation(0);
  },
  onRestart: () => {
    simulation.startNewRun(randomSeed());
    resetRunStats();
    startPlay();
  },
}, {
  hasSave: hasSave(),
  quality: storedQuality,
});

const debug = import.meta.env.DEV ? new DebugPanel({
  teleport: (carIndex) => {
    simulation.state.player.position.x = 0;
    simulation.state.player.position.z = [-27, -9, 9, 27][carIndex] ?? -9;
    simulation.state.player.carIndex = carIndex;
  },
  damageSystem: (id) => simulation.damageSystem(id, 45),
  setPowerProduction: (amount) => { simulation.state.powerProduction += amount; },
  spawnEnemy: (type) => { simulation.spawnEnemy(type, simulation.state.player.carIndex); },
  skipToStation: () => { simulation.reachStation(); },
  grantScrap: (amount) => { simulation.state.scrap += amount; },
  changeSpeed: (amount) => { simulation.state.speed = Math.max(0, simulation.state.speed + amount); },
  toggleColliders: () => ui.showAlert('Collision shapes are active around the car shell.', 'info'),
}) : undefined;

let lastTime = performance.now();
let animationFrame = 0;

function startPlay(): void {
  void audio.unlock();
  input.setEnabled(simulation.state.mode !== 'title' && simulation.state.mode !== 'gameover');
  ui.setPowerPanelOpen(false);
  powerOpen = false;
  if (simulation.state.mode === 'travel') {
    canvas.focus();
    input.requestPointerLock();
  }
  syncPresentation(0);
}

function closePowerPanel(): void {
  if (!powerOpen) return;
  powerOpen = false;
  ui.setPowerPanelOpen(false);
  input.setEnabled(true);
  canvas.focus();
  input.requestPointerLock();
}

function frame(time: number): void {
  const dt = Math.min(0.05, Math.max(0.001, (time - lastTime) / 1000));
  lastTime = time;
  if (simulation.state.mode === 'title') {
    animationFrame = requestAnimationFrame(frame);
    return;
  }
  const snapshot = input.snapshot();
  runStep(dt, snapshot);
  animationFrame = requestAnimationFrame(frame);
}

function runStep(dt: number, snapshot: InputSnapshot, present = true): void {
  const wasMounted = simulation.state.mountedTurretActive;
  if (snapshot.tabPressed && simulation.state.mode === 'travel' && !wasMounted) {
    powerOpen = !powerOpen;
    ui.setPowerPanelOpen(powerOpen);
    if (powerOpen && document.pointerLockElement) void document.exitPointerLock();
    if (!powerOpen) {
      canvas.focus();
      input.requestPointerLock();
    }
  }
  if (snapshot.pausePressed && powerOpen) {
    closePowerPanel();
    snapshot.pausePressed = false;
  }

  const rawMouseX = snapshot.cameraDeltaX;
  const rawMouseY = snapshot.cameraDeltaY;
  if (!wasMounted) scene.rotateCamera(rawMouseX, rawMouseY);
  snapshot.cameraDeltaX = rawMouseX;
  snapshot.cameraDeltaY = rawMouseY;
  if (powerOpen) {
    snapshot.forward = 0;
    snapshot.strafe = 0;
    snapshot.sprint = false;
    snapshot.primaryPressed = false;
    snapshot.primaryHeld = false;
    snapshot.interactPressed = false;
  }

  const wasDamaged = damagedSystemCount();
  const previousMode = simulation.state.mode;
  const events = simulation.update(dt, snapshot);
  if (!wasMounted && simulation.state.mountedTurretActive) {
    input.requestPointerLock();
    ui.showAlert('Rear mount engaged · mouse traverse · LMB fire · E dismount', 'info', 3200);
  }
  const nowDamaged = damagedSystemCount();
  if (nowDamaged < wasDamaged) repairsCompleted += wasDamaged - nowDamaged;
  const currentEnemyCount = simulation.state.enemies.filter((enemy) => enemy.stage !== 'dead').length;
  if (currentEnemyCount < lastEnemyCount && !events.stationReached) enemiesRepelled += lastEnemyCount - currentEnemyCount;
  lastEnemyCount = currentEnemyCount;

  if (simulation.state.mode !== previousMode) {
    powerOpen = false;
    ui.setPowerPanelOpen(false);
    input.setEnabled(simulation.state.mode !== 'title' && simulation.state.mode !== 'gameover');
    if (simulation.state.mode === 'travel') {
      canvas.focus();
      input.requestPointerLock();
    } else if (document.pointerLockElement) {
      void document.exitPointerLock();
    }
    if (simulation.state.mode === 'station') safeSave();
  }
  if (present) syncPresentation(dt, events);
}

function syncPresentation(dt: number, events?: GameplayEvents): void {
  // Player yaw is authoritative. Re-align the orbit every presentation pass so
  // continue/restart/debug teleports cannot leave W moving opposite the view.
  if (!simulation.state.mountedTurretActive) {
    scene.setCameraRotation(simulation.state.player.yaw, simulation.state.player.aimPitch);
  }
  const navigation = getNavigationTarget();
  scene.setNavigationTarget(simulation.state.mode === 'travel' ? navigation.position : undefined, navigation.urgent);
  scene.update(simulation.state, dt, events);
  scene.render();
  audio.update(simulation.state, events);
  ui.setRunSummary({ enemiesRepelled, repairsCompleted, passengersSaved: simulation.state.passengers.filter((p) => p.health > 0).length });
  ui.update(simulation.state);
  ui.setTurretReadout(getTurretReadout());
  ui.setCombatTarget(Boolean(simulation.getHandheldCombatTarget()));
  if (events?.enemyHit) {
    const enemy = simulation.state.enemies.find((candidate) => candidate.id === events.enemyHit?.id);
    ui.pulseCombatHit(enemy?.stage === 'dead');
  }
  if (simulation.state.mode === 'travel') ui.setNavigation(navigation);
  updateInteractionPrompt();
  debug?.update(simulation.state, {
    calls: scene.renderer.info.render.calls,
    triangles: scene.renderer.info.render.triangles,
    geometries: scene.renderer.info.memory.geometries,
    textures: scene.renderer.info.memory.textures,
  });
}

function updateInteractionPrompt(): void {
  if (simulation.state.mode !== 'travel' || powerOpen) {
    ui.clearInteraction();
    ui.clearRepair();
    return;
  }
  if (simulation.state.mountedTurretActive) {
    ui.clearInteraction();
    ui.clearRepair();
    return;
  }
  const id = simulation.getContextualRepairTarget() ?? undefined;
  if (!id) {
    const atTurret = simulation.isAtTurretStation();
    if (atTurret) {
      ui.showInteraction({ action: 'Mount rear turret', target: simulation.state.systems.turret.powered ? 'Manual traverse ready' : 'Turret circuit offline · route power with TAB', key: 'E', dangerous: !simulation.state.systems.turret.powered });
    } else {
      const consoleSystem = simulation.getContextualSystemTarget();
      if (consoleSystem && consoleSystem !== 'turret') {
        const system = simulation.state.systems[consoleSystem];
        ui.showInteraction({
          action: system.powered ? 'Cut circuit power' : 'Route power to system',
          target: `${system.label} · ${system.draw} kW physical console`,
          key: 'E',
          dangerous: system.powered && system.priority >= 8,
        });
      } else {
        const passenger = simulation.getContextualPassenger();
        if (passenger) {
          ui.showInteraction({ action: `Check in with ${passenger.name}`, target: `${passenger.profession} · ${passenger.activity} · ${passenger.ability}`, key: 'E' });
        } else {
          ui.clearInteraction();
        }
      }
    }
    ui.clearRepair();
    return;
  }
  const system = simulation.state.systems[id];
  const prompt = simulation.getRepairPrompt(id);
  if (!prompt || !system.damageKind) return;
  ui.showInteraction({ action: 'Perform repair step', target: `${system.label} · ${prompt.label}`, key: 'E', dangerous: true });
  ui.showRepair({
    label: system.label,
    kind: system.damageKind,
    progress: prompt.progress,
    hint: `E · step ${prompt.index + 1}/${prompt.total} · equip ${prompt.equipment}`,
  });
}

function getNavigationTarget(): NavigationTarget {
  const state = simulation.state;
  const player = state.player.position;
  const distanceTo = (position: Vec3Data) => Math.hypot(position.x - player.x, position.z - player.z);
  const activeEnemies = state.enemies.filter((enemy) => enemy.stage !== 'dead');
  const immediateEnemy = activeEnemies
    .filter((enemy) => enemy.stage === 'inside' || enemy.stage === 'breaching')
    .sort((a, b) => distanceTo(a.position) - distanceTo(b.position))[0];

  let target: { label: string; action: string; carIndex: number; position: Vec3Data; urgent?: boolean } | undefined;
  if (immediateEnemy) {
    target = {
      label: `${immediateEnemy.type} · car ${immediateEnemy.targetCar + 1}`,
      action: 'Intercept boarder',
      carIndex: immediateEnemy.targetCar,
      position: immediateEnemy.position,
      urgent: true,
    };
  }

  if (!target) {
    const damaged = (Object.entries(state.systems) as [SystemId, GameState['systems'][SystemId]][])
      .filter(([, system]) => system.damaged)
      .sort(([a], [b]) => distanceTo(SYSTEM_POSITIONS[a]) - distanceTo(SYSTEM_POSITIONS[b]))[0];
    if (damaged) {
      const [id, system] = damaged;
      target = { label: system.label, action: `Repair ${system.damageKind ?? 'fault'}`, carIndex: SYSTEM_CARS[id], position: SYSTEM_POSITIONS[id], urgent: true };
    }
  }

  if (!target && activeEnemies.length > 0) {
    const enemy = [...activeEnemies].sort((a, b) => distanceTo(a.position) - distanceTo(b.position))[0]!;
    target = { label: `${enemy.type} · car ${enemy.targetCar + 1}`, action: `Boarder ${enemy.stage}`, carIndex: enemy.targetCar, position: enemy.position, urgent: true };
  }

  if (!target) {
    const offline = (Object.entries(state.systems) as [SystemId, GameState['systems'][SystemId]][])
      .filter(([, system]) => !system.powered)
      .sort(([a], [b]) => distanceTo(SYSTEM_POSITIONS[a]) - distanceTo(SYSTEM_POSITIONS[b]))[0];
    const fallback = offline ?? (Object.entries(state.systems) as [SystemId, GameState['systems'][SystemId]][])
      .filter(([id]) => id !== 'turret')
      .sort(([a], [b]) => distanceTo(SYSTEM_POSITIONS[a]) - distanceTo(SYSTEM_POSITIONS[b]))[0]!;
    const [id, system] = fallback;
    target = {
      label: system.label,
      action: system.powered ? 'Nearby console' : 'Restore offline system',
      carIndex: SYSTEM_CARS[id],
      position: SYSTEM_POSITIONS[id],
    };
  }

  const distance = distanceTo(target.position);
  const zDelta = target.position.z - player.z;
  const direction: NavigationReadout['direction'] = distance <= 2.65 ? 'here' : zDelta < 0 ? 'forward' : 'rearward';
  return { ...target, distance, direction };
}

function getTurretReadout(): TurretReadout {
  const state = simulation.state;
  const target = state.turretTargetId == null
    ? undefined
    : state.enemies.find((enemy) => enemy.id === state.turretTargetId && enemy.stage !== 'dead');
  const targetLabel = target
    ? `${target.type} · ${target.stage} · ${target.position.x < 0 ? 'port' : 'starboard'}`
    : undefined;
  return {
    active: state.mountedTurretActive,
    yawDegrees: state.turretYaw * (180 / Math.PI),
    ready: state.turretCooldown <= 0,
    cooldown: state.turretCooldown <= 0 ? 100 : Math.max(0, (1 - state.turretCooldown / 1.5) * 100),
    targetLabel,
    targetHealth: target?.health,
    assisted: state.turretAimAssist,
    gunnerName: state.turretAimAssist ? 'OREN BRASS' : undefined,
  };
}

function reviewPassenger(id: string, choice: PassengerBriefingChoice): void {
  const passenger = simulation.state.passengers.find((candidate) => candidate.id === id);
  if (!passenger) return;
  const result = simulation.talkToPassenger(id, choice);
  ui.showAlert(result.text, result.ok && choice === 'support' ? 'info' : 'warning', 4600);
  syncPresentation(0);
}

function damagedSystemCount(): number {
  return Object.values(simulation.state.systems).filter((system) => system.damaged).length;
}

function resetRunStats(): void {
  enemiesRepelled = 0;
  repairsCompleted = 0;
  lastEnemyCount = 0;
}

function randomSeed(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] || 0x4c544e;
}

function hasSave(): boolean {
  try { return localStorage.getItem(SAVE_KEY) !== null; } catch { return false; }
}

function safeSave(): void {
  try { localStorage.setItem(SAVE_KEY, simulation.save()); } catch { ui.showAlert('The conductor log could not be written.', 'warning'); }
}

function safeLoad(): boolean {
  try {
    const save = localStorage.getItem(SAVE_KEY);
    if (!save) return false;
    simulation.load(save);
    return true;
  } catch {
    ui.showAlert('The last conductor log is unreadable.', 'danger');
    return false;
  }
}

function readQuality(): QualitySettings['preset'] {
  try {
    const value = localStorage.getItem(QUALITY_KEY);
    if (value === 'low' || value === 'medium' || value === 'high' || value === 'ultra') return value;
  } catch { /* private mode */ }
  return 'high';
}

function resize(): void {
  scene.resize(app.clientWidth, app.clientHeight, window.devicePixelRatio);
}

window.addEventListener('resize', resize);
document.addEventListener('fullscreenchange', resize);
resize();
syncPresentation(0);
animationFrame = requestAnimationFrame(frame);

window.render_game_to_text = () => {
  const payload = JSON.parse(simulation.renderToText()) as Record<string, unknown>;
  if (simulation.state.mode === 'travel') {
    const navigation = getNavigationTarget();
    payload.navigation = {
      action: navigation.action,
      target: navigation.label,
      car: navigation.carIndex,
      distance: Math.round(navigation.distance * 10) / 10,
      direction: navigation.direction,
      urgent: Boolean(navigation.urgent),
    };
  }
  return JSON.stringify(payload);
};
window.advanceTime = (milliseconds: number) => {
  cancelAnimationFrame(animationFrame);
  const steps = Math.max(1, Math.round(milliseconds / (1000 / 60)));
  for (let index = 0; index < steps; index += 1) runStep(1 / 60, input.snapshot(), index === steps - 1);
};
window.__lastTrain = { simulation, scene, ui };

window.addEventListener('beforeunload', () => {
  cancelAnimationFrame(animationFrame);
  scene.dispose();
  void audio.dispose();
  input.destroy();
  ui.destroy();
  debug?.destroy();
});

declare global {
  interface Window {
    render_game_to_text: () => string;
    advanceTime: (milliseconds: number) => void;
    __lastTrain: { simulation: GameplaySimulation; scene: TrainScene; ui: GameUI };
  }
}
