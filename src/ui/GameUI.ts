import type {
  DamageKind,
  GameState,
  PassengerState,
  QualitySettings,
  SystemId,
  TrainSystemState,
  UpgradeState,
} from '../shared/types';

export type RouteChoice = 'salt-cut' | 'dead-forest';
export type PassengerBriefingChoice = 'support' | 'challenge';

export interface GameUICallbacks {
  onStart?: () => void;
  onContinue?: () => void;
  onToggleSystem?: (system: SystemId, powered: boolean) => void;
  onClosePower?: () => void;
  onRepairTrain?: () => void;
  onBuyUpgrade?: (upgradeId: string) => void;
  onPassengerChoice?: (passengerId: string, choice: PassengerBriefingChoice) => void;
  onDeal?: (accepted: boolean) => void;
  onChooseRoute?: (route: RouteChoice) => void;
  onDepart?: () => void;
  onResume?: () => void;
  onQualityChange?: (preset: QualitySettings['preset']) => void;
  onSaveAndQuit?: () => void;
  onRestart?: () => void;
}

export interface GameUIOptions {
  hasSave?: boolean;
  quality?: QualitySettings['preset'];
}

export interface InteractionReadout {
  action: string;
  target?: string;
  key?: string;
  dangerous?: boolean;
}

export interface RepairReadout {
  label: string;
  kind: DamageKind;
  progress: number;
  hint?: string;
}

export interface RunSummary {
  enemiesRepelled?: number;
  repairsCompleted?: number;
  passengersSaved?: number;
}

export interface TurretReadout {
  active: boolean;
  yawDegrees: number;
  ready: boolean;
  targetLabel?: string;
  targetHealth?: number;
  assisted?: boolean;
  gunnerName?: string;
  cooldown?: number;
}

export interface NavigationReadout {
  label: string;
  action: string;
  carIndex: number;
  distance: number;
  direction: 'forward' | 'rearward' | 'here';
  urgent?: boolean;
}

const SYSTEM_ORDER: SystemId[] = [
  'engine',
  'cooling',
  'lights',
  'locks',
  'radar',
  'turret',
  'medical',
];

const EQUIPMENT_LABELS = {
  wrench: 'Hardened wrench',
  sidearm: 'K-12 sidearm',
  'arc-tool': 'Arc repair tool',
} as const;

const DAMAGE_LABELS: Record<DamageKind, string> = {
  electrical: 'LIVE CIRCUIT',
  overheat: 'THERMAL FAULT',
  jam: 'MECHANISM JAM',
  breach: 'HULL BREACH',
  fire: 'ACTIVE FIRE',
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function text<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  content: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = content;
  return element;
}

/**
 * DOM presentation for the game. It never mutates authoritative GameState;
 * actions are emitted through callbacks for the simulation to resolve.
 */
export class GameUI {
  private callbacks: GameUICallbacks;
  private state?: GameState;
  private powerPanelOpen = false;
  private controlsOpen = false;
  private selectedRoute: RouteChoice = 'salt-cut';
  private quality: QualitySettings['preset'];
  private runSummary: RunSummary = {};
  private turretReadout: TurretReadout = { active: false, yawDegrees: 0, ready: false };
  private alertTimer?: number;
  private combatFeedbackTimer?: number;
  private lastStationSignature = '';

  private readonly shell: HTMLDivElement;
  private readonly titleScreen: HTMLElement;
  private readonly titleContinue: HTMLButtonElement;
  private readonly controlsPanel: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly powerPanel: HTMLElement;
  private readonly stationScreen: HTMLElement;
  private readonly pauseScreen: HTMLElement;
  private readonly gameOverScreen: HTMLElement;
  private readonly interaction: HTMLElement;
  private readonly repair: HTMLElement;
  private readonly alert: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly turretHud: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    callbacks: GameUICallbacks = {},
    options: GameUIOptions = {},
  ) {
    this.callbacks = callbacks;
    this.quality = options.quality ?? 'high';
    this.root.classList.add('game-root');

    this.shell = document.createElement('div');
    this.shell.className = 'game-ui';
    this.shell.innerHTML = this.template();
    this.root.append(this.shell);

    this.titleScreen = this.required('[data-screen="title"]');
    this.titleContinue = this.required<HTMLButtonElement>('[data-action="continue"]');
    this.controlsPanel = this.required('[data-panel="controls"]');
    this.hud = this.required('[data-layer="hud"]');
    this.powerPanel = this.required('[data-screen="power"]');
    this.stationScreen = this.required('[data-screen="station"]');
    this.pauseScreen = this.required('[data-screen="pause"]');
    this.gameOverScreen = this.required('[data-screen="gameover"]');
    this.interaction = this.required('[data-layer="interaction"]');
    this.repair = this.required('[data-layer="repair"]');
    this.alert = this.required('[data-layer="alert"]');
    this.crosshair = this.required('[data-layer="crosshair"]');
    this.turretHud = this.required('[data-layer="turret"]');

    this.setContinueAvailable(Boolean(options.hasSave));
    this.bindEvents();
    this.updateQualityButtons();
  }

  setCallbacks(callbacks: GameUICallbacks): void {
    this.callbacks = callbacks;
  }

  setContinueAvailable(available: boolean): void {
    this.titleContinue.disabled = !available;
    this.titleContinue.setAttribute('aria-disabled', String(!available));
    const note = this.titleContinue.querySelector('.menu-button__note');
    if (note) note.textContent = available ? 'resume the last signal' : 'no signal found';
  }

  update(state: GameState): void {
    this.state = state;
    this.shell.dataset.mode = state.mode;
    this.titleScreen.hidden = state.mode !== 'title';
    this.hud.hidden = state.mode !== 'travel';
    this.stationScreen.hidden = state.mode !== 'station';
    this.pauseScreen.hidden = state.mode !== 'paused';
    this.gameOverScreen.hidden = state.mode !== 'gameover';

    if (state.mode !== 'travel') this.setPowerPanelOpen(false);
    this.renderHud(state);
    this.renderPower(state);

    if (state.mode === 'station') {
      const signature = `${state.stationVisits}:${state.scrap}:${state.hull}:${state.upgrades.map((item) => `${item.id}:${item.purchased}`).join('|')}:${state.passengers.map((item) => `${item.id}:${item.morale}:${item.health}:${item.loyalty}:${(item as PassengerState & { activity?: string; lastBriefingVisit?: number }).activity}:${(item as PassengerState & { activity?: string; lastBriefingVisit?: number }).lastBriefingVisit}`).join('|')}:${state.dealTaken}`;
      if (signature !== this.lastStationSignature) {
        this.renderStation(state);
        this.lastStationSignature = signature;
      }
    }

    if (state.mode === 'gameover') this.renderGameOver(state);
    if (state.mode === 'title') this.alert.hidden = true;
    else if (state.message && state.messageTimer > 0) this.showAlert(state.message, state.alarm ? 'danger' : 'info');
  }

  setPowerPanelOpen(open: boolean): void {
    this.powerPanelOpen = open && this.state?.mode === 'travel';
    this.powerPanel.hidden = !this.powerPanelOpen;
    this.powerPanel.setAttribute('aria-hidden', String(!this.powerPanelOpen));
    this.shell.classList.toggle('is-managing-power', this.powerPanelOpen);
  }

  togglePowerPanel(): void {
    this.setPowerPanelOpen(!this.powerPanelOpen);
  }

  setControlsVisible(visible: boolean): void {
    this.controlsOpen = visible;
    this.controlsPanel.hidden = !visible;
    this.titleScreen.classList.toggle('has-controls', visible);
  }

  showInteraction(readout: InteractionReadout | string, target = '', key = 'E'): void {
    const value: InteractionReadout = typeof readout === 'string'
      ? { action: readout, target, key }
      : readout;
    this.required<HTMLElement>('[data-bind="interact-key"]', this.interaction).textContent = value.key ?? 'E';
    this.required<HTMLElement>('[data-bind="interact-action"]', this.interaction).textContent = value.action;
    this.required<HTMLElement>('[data-bind="interact-target"]', this.interaction).textContent = value.target ?? '';
    this.interaction.classList.toggle('is-dangerous', Boolean(value.dangerous));
    this.interaction.hidden = false;
  }

  clearInteraction(): void {
    this.interaction.hidden = true;
  }

  showRepair(readout: RepairReadout): void {
    this.interaction.hidden = true;
    const progress = clamp(readout.progress);
    const prompt = this.formatRepairPrompt(readout.hint);
    this.required<HTMLElement>('[data-bind="repair-label"]', this.repair).textContent = readout.label;
    this.required<HTMLElement>('[data-bind="repair-kind"]', this.repair).textContent = DAMAGE_LABELS[readout.kind];
    this.required<HTMLElement>('[data-bind="repair-key"]', this.repair).textContent = prompt.key;
    this.required<HTMLElement>('[data-bind="repair-hint"]', this.repair).textContent = prompt.instruction;
    this.required<HTMLElement>('[data-bind="repair-percent"]', this.repair).textContent = `${Math.round(progress)}%`;
    this.required<HTMLElement>('[data-bind="repair-fill"]', this.repair).style.width = `${progress}%`;
    const track = this.required<HTMLElement>('.repair-track', this.repair);
    track.setAttribute('aria-valuenow', String(Math.round(progress)));
    track.setAttribute('aria-valuetext', `${Math.round(progress)} percent repaired`);
    this.repair.setAttribute('aria-label', `${DAMAGE_LABELS[readout.kind]} on ${readout.label}. ${prompt.instruction}. ${Math.round(progress)} percent complete.`);
    this.repair.dataset.kind = readout.kind;
    this.repair.hidden = false;
  }

  clearRepair(): void {
    this.repair.hidden = true;
  }

  showAlert(message: string, tone: 'info' | 'warning' | 'danger' = 'warning', duration = 2800): void {
    if (this.alert.textContent === message && !this.alert.hidden) return;
    window.clearTimeout(this.alertTimer);
    this.alert.textContent = message;
    this.alert.dataset.tone = tone;
    this.alert.hidden = false;
    this.alert.classList.remove('is-entering');
    void this.alert.offsetWidth;
    this.alert.classList.add('is-entering');
    this.alertTimer = window.setTimeout(() => {
      this.alert.hidden = true;
    }, duration);
  }

  setRunSummary(summary: RunSummary): void {
    this.runSummary = summary;
    if (this.state?.mode === 'gameover') this.renderGameOver(this.state);
  }

  setTurretReadout(readout: TurretReadout): void {
    this.turretReadout = readout;
    const active = readout.active && this.state?.mode === 'travel';
    this.turretHud.hidden = !active;
    this.shell.classList.toggle('is-operating-turret', active);
    if (!active) return;

    const yaw = Math.max(-70, Math.min(70, readout.yawDegrees));
    this.bindText('turret-bearing', `${yaw >= 0 ? '+' : '−'}${String(Math.abs(Math.round(yaw))).padStart(2, '0')}°`);
    this.bindStyle('turret-bearing-tick', 'left', `${50 + yaw / 1.4}%`);
    this.bindText('turret-target', readout.targetLabel ? readout.targetLabel.toUpperCase() : 'NO TARGET IN SIGHTLINE');
    this.bindText('turret-target-health', readout.targetHealth == null ? '—' : `${Math.round(clamp(readout.targetHealth))}%`);
    this.bindText('turret-cycle', readout.ready ? 'CHAMBER READY' : `CYCLING ${Math.round(clamp(readout.cooldown ?? 0))}%`);
    this.bindText('turret-gunner', readout.assisted ? `${readout.gunnerName || 'GUNNER'} · ASSISTED LAY` : 'MANUAL LAY · NO ASSIST');
    this.turretHud.classList.toggle('has-target', Boolean(readout.targetLabel));
    this.turretHud.classList.toggle('is-ready', readout.ready);
    this.turretHud.classList.toggle('is-assisted', Boolean(readout.assisted));
    this.turretHud.setAttribute('aria-label', `Mounted turret. ${readout.ready ? 'Weapon ready.' : 'Weapon cycling.'} ${readout.targetLabel ? `${readout.targetLabel} in sightline.` : 'No target in sightline.'}`);
  }

  setCombatTarget(locked: boolean): void {
    this.crosshair.classList.toggle('has-target', locked);
  }

  pulseCombatHit(killed = false): void {
    window.clearTimeout(this.combatFeedbackTimer);
    this.crosshair.classList.remove('did-hit', 'did-kill');
    // Force a style flush so rapid held-trigger hits still retrigger the snap.
    void this.crosshair.offsetWidth;
    this.crosshair.classList.add(killed ? 'did-kill' : 'did-hit');
    this.combatFeedbackTimer = window.setTimeout(() => {
      this.crosshair.classList.remove('did-hit', 'did-kill');
    }, killed ? 260 : 150);
  }

  setNavigation(readout: NavigationReadout): void {
    const navigator = this.required<HTMLElement>('[data-bind="navigator"]', this.hud);
    this.bindText('nav-action', readout.action.toUpperCase());
    this.bindText('nav-target', readout.label.toUpperCase());
    this.bindText('nav-distance', readout.direction === 'here' ? 'AT CONSOLE' : `${Math.max(1, Math.ceil(readout.distance))} M`);
    this.bindText('nav-direction', readout.direction === 'forward' ? 'TOWARD LOCOMOTIVE' : readout.direction === 'rearward' ? 'TOWARD REAR' : 'PRESS E TO OPERATE');
    this.bindText('nav-arrow', readout.direction === 'forward' ? '▲' : readout.direction === 'rearward' ? '▼' : '◆');
    navigator.dataset.direction = readout.direction;
    navigator.classList.toggle('is-urgent', Boolean(readout.urgent));
    this.hud.querySelectorAll<HTMLElement>('[data-nav-car]').forEach((car) => {
      const index = Number(car.dataset.navCar);
      car.classList.toggle('is-current', index === this.state?.player.carIndex);
      car.classList.toggle('is-target', index === readout.carIndex);
      const damaged = Object.values(this.state?.systems ?? {}).some((system) => system.damaged && SYSTEM_ORDER.indexOf(system.id) >= 0 && this.systemCar(system.id) === index);
      car.classList.toggle('has-fault', damaged);
    });
  }

  setQuality(preset: QualitySettings['preset']): void {
    this.quality = preset;
    this.updateQualityButtons();
  }

  destroy(): void {
    window.clearTimeout(this.alertTimer);
    window.clearTimeout(this.combatFeedbackTimer);
    this.shell.remove();
    this.root.classList.remove('game-root');
  }

  private template(): string {
    return `
      <section class="screen title-screen" data-screen="title" aria-labelledby="game-title">
        <div class="title-atmosphere" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="title-rail" aria-hidden="true"></div>
        <header class="title-lockup">
          <p class="eyebrow"><span>Long-range service № 9</span><span>Eastbound / final departure</span></p>
          <h1 id="game-title"><span>Last Train</span><em>to</em><strong>Nowhere</strong></h1>
          <p class="title-tagline">Keep her moving. Keep them out.</p>
        </header>
        <nav class="title-menu" aria-label="Main menu">
          <button class="menu-button menu-button--primary" type="button" data-action="start">
            <span>Begin departure</span><small class="menu-button__note">a new run into the ash</small>
          </button>
          <button class="menu-button" type="button" data-action="continue">
            <span>Continue journey</span><small class="menu-button__note">no signal found</small>
          </button>
          <button class="menu-button" type="button" data-action="controls">
            <span>Operator’s manual</span><small class="menu-button__note">controls &amp; survival</small>
          </button>
        </nav>
        <aside class="controls-sheet" data-panel="controls" aria-label="Controls" hidden>
          <div class="panel-stamp">Issued to train crew</div>
          <div class="controls-sheet__heading"><p>Operator’s manual</p><button type="button" data-action="close-controls" aria-label="Close controls">×</button></div>
          <dl class="control-grid">
            <div><dt>W A S D</dt><dd>Move through cars</dd></div><div><dt>Mouse</dt><dd>Look / aim</dd></div>
            <div><dt>Shift</dt><dd>Sprint</dd></div><div><dt>Space</dt><dd>Dodge / vault</dd></div>
            <div><dt>E</dt><dd>Interact / repair / mount</dd></div><div><dt>LMB · RMB</dt><dd>Use / fire · aim</dd></div>
            <div><dt>R</dt><dd>Reload K-12 magazine</dd></div><div><dt>1 · 2 · 3</dt><dd>Wrench / K-12 / arc-tool</dd></div>
            <div><dt>1 · 2 · 3</dt><dd>Equipment</dd></div><div><dt>Tab</dt><dd>Power schematic</dd></div>
            <div><dt>Esc</dt><dd>Pause train log</dd></div>
          </dl>
          <p class="controls-tip">Listen for metal strain. Every failure has a place, a sound, and a cost.</p>
        </aside>
        <footer class="title-footer"><span>Deterministic run system</span><span class="signal-dot">Signal unstable</span><span>v.1 / Ash Frontier</span></footer>
      </section>

      <section class="hud" data-layer="hud" aria-label="Train status" hidden>
        <div class="hud-objective">
          <span class="hud-index">RUN DIRECTIVE</span><p data-bind="objective">Reach the next station</p>
          <div class="route-progress"><i data-bind="route-progress"></i></div>
          <small><span data-bind="station-name">Outpost</span><b data-bind="region-time">00:00</b></small>
        </div>
        <section class="hud-navigator" data-bind="navigator" aria-label="Train navigation">
          <div class="nav-callout">
            <span data-bind="nav-action">RESTORE SYSTEM</span>
            <strong data-bind="nav-target">TRACK RADAR</strong>
            <small><b data-bind="nav-distance">16 M</b><i data-bind="nav-direction">TOWARD LOCOMOTIVE</i></small>
          </div>
          <div class="nav-vector" aria-hidden="true"><b data-bind="nav-arrow">▲</b><span>TRAIN AXIS</span></div>
          <ol class="train-strip" aria-label="Four-car train position">
            <li data-nav-car="0"><b>01</b><span>LOCO</span><i></i></li>
            <li data-nav-car="1"><b>02</b><span>ENG</span><i></i></li>
            <li data-nav-car="2"><b>03</b><span>CREW</span><i></i></li>
            <li data-nav-car="3"><b>04</b><span>DEF</span><i></i></li>
          </ol>
        </section>
        <div class="hud-vitals">
          <div class="vital vital--health"><span>VIT</span><div><i data-bind="health-fill"></i></div><b data-bind="health">100</b></div>
          <div class="equipment-readout"><span data-bind="equipment-index">02</span><div><strong data-bind="equipment">K-12 sidearm</strong><small data-bind="ammo-label">AMMUNITION</small></div><b data-bind="ammo">12</b></div>
        </div>
        <div class="hud-train">
          <div class="dial" data-bind="speed-dial"><div class="dial__needle" data-bind="speed-needle"></div><b data-bind="speed">083</b><span>KM/H</span></div>
          <div class="reserve"><span>GRID RESERVE</span><strong data-bind="reserve">12 KW</strong><div><i data-bind="reserve-fill"></i></div><small data-bind="battery">BAT 74%</small></div>
          <div class="warning-stack" data-bind="warnings" aria-live="polite"></div>
        </div>
        <div class="threat-compass" data-bind="threats" hidden><i>‹</i><span>BOARDERS</span><i>›</i></div>
        <div class="tab-hint"><kbd>TAB</kbd><span>grid</span></div>
        <div class="control-ribbon" aria-label="Gameplay controls">
          <span><kbd>WASD</kbd> MOVE</span><span><kbd>SHIFT</kbd> SPRINT</span><span><kbd>SPACE</kbd> DODGE</span><span><kbd>RMB</kbd> AIM</span><span><kbd>LMB</kbd> FIRE</span><span><kbd>R</kbd> RELOAD</span><span><kbd>E</kbd> USE</span><span><kbd>TAB</kbd> GRID</span>
        </div>
      </section>

      <div class="crosshair" data-layer="crosshair" aria-hidden="true" hidden><i></i><i></i><i></i><i></i><b></b></div>
      <section class="turret-hud" data-layer="turret" role="region" aria-live="off" hidden>
        <header class="turret-heading"><span>DEFENSE CAR / REAR MOUNT № 2</span><strong data-bind="turret-cycle">CHAMBER READY</strong></header>
        <div class="turret-reticle" aria-hidden="true">
          <i class="turret-reticle__arc"></i><i class="turret-reticle__horizon"></i><i class="turret-reticle__post"></i>
          <span class="turret-reticle__bracket turret-reticle__bracket--left"></span><span class="turret-reticle__bracket turret-reticle__bracket--right"></span>
          <b></b>
        </div>
        <div class="turret-bearing"><span>REAR TRAVERSE</span><div><i data-bind="turret-bearing-tick"></i></div><b data-bind="turret-bearing">+00°</b></div>
        <div class="turret-contact"><span>OPTICAL CONTACT</span><strong data-bind="turret-target">NO TARGET IN SIGHTLINE</strong><small>STRUCTURE <b data-bind="turret-target-health">—</b></small></div>
        <div class="turret-assist"><i></i><span data-bind="turret-gunner">MANUAL LAY · NO ASSIST</span></div>
        <footer class="turret-controls"><span><kbd>MOUSE</kbd> traverse</span><span><kbd>LMB</kbd> fire</span><span><kbd>E</kbd> dismount</span></footer>
      </section>
      <div class="interaction-readout" data-layer="interaction" role="status" hidden>
        <kbd data-bind="interact-key">E</kbd><div><strong data-bind="interact-action">Operate</strong><span data-bind="interact-target"></span></div>
      </div>
      <div class="repair-readout" data-layer="repair" role="status" hidden>
        <header><span data-bind="repair-kind">LIVE CIRCUIT</span><b data-bind="repair-percent">0%</b></header>
        <div class="repair-target"><span>TARGETED SYSTEM</span><strong data-bind="repair-label">Engineering bus</strong></div>
        <div class="repair-track" role="progressbar" aria-label="Repair progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i data-bind="repair-fill"></i></div>
        <div class="repair-command"><kbd data-bind="repair-key">E</kbd><div><span>NEXT REPAIR INPUT</span><strong data-bind="repair-hint">Hold steady to complete this step</strong></div></div>
      </div>
      <div class="game-alert" data-layer="alert" role="alert" hidden></div>

      <section class="screen power-screen" data-screen="power" aria-labelledby="power-title" hidden>
        <div class="power-cabinet">
          <header class="cabinet-header">
            <div><small>Morrow Electric Works / Model 44-C</small><h2 id="power-title">Distribution Control</h2></div>
            <div class="grid-frequency"><span>GRID</span><b>60<small>c/s</small></b></div>
            <button class="cabinet-close" type="button" data-action="close-power"><kbd>TAB</kbd> return to train</button>
          </header>
          <div class="cabinet-status">
            <div><span>GENERATOR</span><strong data-bind="power-production">36 kW</strong></div>
            <div class="cabinet-meter"><i data-bind="load-needle"></i><span>LOAD</span><b data-bind="power-load">00 / 36</b></div>
            <div><span>ACCUMULATOR</span><strong data-bind="power-battery">74%</strong></div>
            <p data-bind="power-status">GRID WITHIN TOLERANCE</p>
          </div>
          <div class="schematic" data-bind="schematic" aria-label="Power circuits"></div>
          <footer class="cabinet-footer"><span>Throw a knife switch to reroute power immediately.</span><span><i class="legend-light is-on"></i> energized <i class="legend-light"></i> isolated <i class="legend-light is-fault"></i> fault</span></footer>
        </div>
      </section>

      <section class="screen station-screen" data-screen="station" aria-labelledby="station-title" hidden>
        <header class="station-header">
          <div><p class="eyebrow">Safe enough to stop / not safe enough to stay</p><h2 id="station-title" data-bind="station-title">Gallowglass Depot</h2></div>
          <div class="station-wallet"><span>SALVAGE ON HAND</span><strong><i>⦿</i> <b data-bind="station-scrap">0</b></strong></div>
        </header>
        <div class="station-layout">
          <main class="station-ledger">
            <section class="station-section train-service" aria-labelledby="service-title">
              <div class="section-heading"><div><span>01 / TRAIN SERVICE</span><h3 id="service-title">Patch her up</h3></div><p data-bind="repair-copy">Hull holding.</p></div>
              <button class="service-ticket" type="button" data-action="repair-train"><span><i>WORK ORDER</i><b>Field hull repair</b><small>Rivets, plate and two willing hands</small></span><strong data-bind="repair-cost">12</strong></button>
            </section>
            <section class="station-section" aria-labelledby="upgrades-title">
              <div class="section-heading"><div><span>02 / MACHINE SHOP</span><h3 id="upgrades-title">Permanent fittings</h3></div><p>One installation before departure.</p></div>
              <div class="upgrade-grid" data-bind="upgrades"></div>
            </section>
            <section class="station-section" aria-labelledby="passengers-title">
              <div class="section-heading"><div><span>03 / ONBOARD CREW</span><h3 id="passengers-title">Crew manifest &amp; briefings</h3></div><p>Trust and morale change field performance.</p></div>
              <p class="crew-intro">Review each specialist’s live duty, condition and confidence. Choose one briefing approach per stop; what you say changes how effectively they work.</p>
              <div class="passenger-grid" data-bind="passengers"></div>
            </section>
          </main>
          <aside class="departure-board">
            <section class="deal-card" data-bind="deal-card">
              <span class="deal-card__stamp">UNMANIFESTED</span><small>QUESTIONABLE OFFER</small><h3>A sealed black canister</h3>
              <p>A platform porter offers a tuned auxiliary reactor. No charge. He will not say what it burns.</p>
              <blockquote>“It runs quiet. Most nights.”</blockquote>
              <div><button type="button" data-action="deal-accept">Install it</button><button type="button" data-action="deal-refuse">Refuse</button></div>
            </section>
            <section class="route-card">
              <span>04 / ROUTE OFFICE</span><h3>Choose the next line</h3>
              <label class="route-option is-selected"><input type="radio" name="route" value="salt-cut" checked><i></i><span><b>The Salt Cut</b><small>Fast · exposed · electrical storms</small></span></label>
              <label class="route-option"><input type="radio" name="route" value="dead-forest"><i></i><span><b>Dead Forest Branch</b><small>Slow · cover · heavy boarders</small></span></label>
            </section>
            <button class="depart-button" type="button" data-action="depart"><span>Sound departure</span><small>Nothing else can be changed beyond this point</small></button>
          </aside>
        </div>
      </section>

      <section class="screen pause-screen" data-screen="pause" aria-labelledby="pause-title" hidden>
        <div class="pause-card">
          <p class="eyebrow">Service temporarily suspended</p><h2 id="pause-title">The train waits<br><em>for no one.</em></h2>
          <button class="pause-resume" type="button" data-action="resume"><span>Resume journey</span><kbd>ESC</kbd></button>
          <fieldset class="quality-picker"><legend>Rendering machinery</legend>
            <button type="button" data-quality="low"><b>Low</b><small>lean</small></button><button type="button" data-quality="medium"><b>Medium</b><small>steady</small></button>
            <button type="button" data-quality="high"><b>High</b><small>rich</small></button><button type="button" data-quality="ultra"><b>Ultra</b><small>full</small></button>
          </fieldset>
          <div class="pause-meta"><span>Changes take effect immediately.</span><button type="button" data-action="save-quit">Save &amp; return to title</button></div>
        </div>
      </section>

      <section class="screen gameover-screen" data-screen="gameover" aria-labelledby="gameover-title" hidden>
        <div class="gameover-vignette"></div><article class="run-report">
          <header><span>FINAL MOVEMENT REPORT · FORM 19B</span><b data-bind="report-seed">RUN 0000</b></header>
          <p class="eyebrow">Service on this line has ended</p><h2 id="gameover-title">The rails go on.<br><em>You do not.</em></h2>
          <p class="failure-reason" data-bind="gameover-reason">The train was lost to the ash.</p>
          <dl class="summary-grid"><div><dt>Time in motion</dt><dd data-bind="summary-time">00:00</dd></div><div><dt>Regions crossed</dt><dd data-bind="summary-regions">0</dd></div><div><dt>Threats repelled</dt><dd data-bind="summary-enemies">—</dd></div><div><dt>Repairs made</dt><dd data-bind="summary-repairs">—</dd></div><div><dt>Passengers safe</dt><dd data-bind="summary-passengers">0</dd></div><div><dt>Hull remaining</dt><dd data-bind="summary-hull">0%</dd></div></dl>
          <div class="report-actions"><button type="button" data-action="restart">Make another run</button><button type="button" data-action="save-quit">Return to title</button></div>
        </article>
      </section>`;
  }

  private bindEvents(): void {
    this.shell.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button || button.disabled) return;
      const action = button.dataset.action;
      if (action === 'start') this.callbacks.onStart?.();
      if (action === 'continue') this.callbacks.onContinue?.();
      if (action === 'controls') this.setControlsVisible(true);
      if (action === 'close-controls') this.setControlsVisible(false);
      if (action === 'close-power') {
        this.setPowerPanelOpen(false);
        this.callbacks.onClosePower?.();
      }
      if (action === 'resume') this.callbacks.onResume?.();
      if (action === 'save-quit') this.callbacks.onSaveAndQuit?.();
      if (action === 'restart') this.callbacks.onRestart?.();
      if (action === 'repair-train') this.callbacks.onRepairTrain?.();
      if (action === 'deal-accept') this.callbacks.onDeal?.(true);
      if (action === 'deal-refuse') this.callbacks.onDeal?.(false);
      if (action === 'depart') this.callbacks.onDepart?.();

      if (button.dataset.system) {
        const id = button.dataset.system as SystemId;
        const nextPowered = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', String(nextPowered));
        button.classList.toggle('is-on', nextPowered);
        this.callbacks.onToggleSystem?.(id, nextPowered);
      }
      if (button.dataset.upgrade) this.callbacks.onBuyUpgrade?.(button.dataset.upgrade);
      if (button.dataset.passenger) this.callbacks.onPassengerChoice?.(
        button.dataset.passenger,
        button.dataset.passengerChoice === 'challenge' ? 'challenge' : 'support',
      );
      if (button.dataset.quality) {
        const preset = button.dataset.quality as QualitySettings['preset'];
        this.setQuality(preset);
        this.callbacks.onQualityChange?.(preset);
      }
    });

    this.shell.addEventListener('change', (event) => {
      const radio = (event.target as HTMLElement).closest<HTMLInputElement>('input[name="route"]');
      if (!radio) return;
      this.selectedRoute = radio.value as RouteChoice;
      this.stationScreen.querySelectorAll('.route-option').forEach((label) => {
        label.classList.toggle('is-selected', label.contains(radio));
      });
      this.callbacks.onChooseRoute?.(this.selectedRoute);
    });
  }

  private renderHud(state: GameState): void {
    this.bindText('objective', state.objective || 'Keep the train moving');
    this.bindText('station-name', `NEXT · ${state.stationName || 'UNKNOWN'}`);
    this.bindText('region-time', formatDuration(Math.max(0, state.regionDuration - state.regionTime)));
    this.bindStyle('route-progress', 'width', `${clamp((state.regionTime / Math.max(1, state.regionDuration)) * 100)}%`);

    const health = clamp((state.player.health / Math.max(1, state.player.maxHealth)) * 100);
    this.bindText('health', String(Math.ceil(state.player.health)));
    this.bindStyle('health-fill', 'width', `${health}%`);
    const equipmentIndex = state.player.equipment === 'wrench' ? '01' : state.player.equipment === 'sidearm' ? '02' : '03';
    this.bindText('equipment-index', equipmentIndex);
    this.bindText('equipment', EQUIPMENT_LABELS[state.player.equipment]);
    this.bindText('ammo-label', state.player.equipment === 'sidearm' ? (state.player.reloading ? 'RELOADING' : 'MAG / RESERVE') : state.player.equipment === 'arc-tool' ? 'TOOL CHARGE' : 'IMPACT TOOL');
    this.bindText('ammo', state.player.equipment === 'sidearm' ? `${String(state.player.ammo).padStart(2, '0')}/${String(state.player.reserveAmmo).padStart(2, '0')}` : state.player.equipment === 'arc-tool' ? `${Math.round(state.player.toolCharge)}%` : '∞');

    this.bindText('speed', String(Math.round(state.speed)).padStart(3, '0'));
    this.bindStyle('speed-needle', 'transform', `rotate(${(-118 + clamp(state.speed, 0, 160) / 160 * 236).toFixed(1)}deg)`);
    const reserve = state.powerProduction - state.powerDraw;
    this.bindText('reserve', `${reserve >= 0 ? '+' : ''}${Math.round(reserve)} kW`);
    this.bindText('battery', `BAT ${Math.round((state.battery / Math.max(1, state.maxBattery)) * 100)}%`);
    this.bindStyle('reserve-fill', 'width', `${clamp((Math.max(0, reserve) / Math.max(1, state.powerProduction)) * 100)}%`);

    this.crosshair.hidden = state.mode !== 'travel' || state.player.equipment === 'wrench';
    this.crosshair.classList.toggle('is-aiming', state.player.aiming);
    this.crosshair.classList.toggle('is-moving', state.player.moveSpeed > 0.8);
    this.crosshair.classList.toggle('is-recovering', state.player.weaponCooldown > 0.025);
    this.crosshair.classList.toggle('is-dodging', state.player.dodging);
    this.crosshair.classList.toggle('is-reloading', state.player.reloading);
    const spread = state.player.dodging
      ? 38
      : (state.player.aiming ? 18 : 25) + Math.min(9, state.player.moveSpeed * 1.15) + state.player.recoil * 10;
    this.crosshair.style.setProperty('--crosshair-size', `${spread.toFixed(1)}px`);
    this.crosshair.style.setProperty('--recoil-kick', `${(state.player.recoil * 7).toFixed(1)}px`);
    this.crosshair.dataset.equipment = state.player.equipment;
    this.shell.classList.toggle('is-aiming', state.player.aiming && state.player.equipment !== 'wrench');
    this.shell.classList.toggle('is-sprinting', state.player.sprinting);
    this.shell.classList.toggle('is-dodging', state.player.dodging);
    this.renderWarnings(state);
  }

  private systemCar(id: SystemId): number {
    if (id === 'engine' || id === 'radar') return 0;
    if (id === 'cooling') return 1;
    if (id === 'lights' || id === 'locks' || id === 'medical') return 2;
    return 3;
  }

  private renderWarnings(state: GameState): void {
    const container = this.required<HTMLElement>('[data-bind="warnings"]');
    const warnings = Object.values(state.systems)
      .filter((system) => system.damaged || (!system.powered && system.priority >= 2))
      .sort((a, b) => Number(b.damaged) - Number(a.damaged) || b.priority - a.priority)
      .slice(0, 3);
    container.replaceChildren(...warnings.map((system) => {
      const item = text('span', system.damaged ? 'is-critical' : '', `${system.label} · ${system.damaged ? system.damageKind?.toUpperCase() ?? 'FAULT' : 'OFFLINE'}`);
      return item;
    }));
    const threats = state.enemies.filter((enemy) => enemy.stage !== 'dead');
    const compass = this.required<HTMLElement>('[data-bind="threats"]');
    compass.hidden = threats.length === 0;
    compass.classList.toggle('has-left', threats.some((enemy) => enemy.side < 0));
    compass.classList.toggle('has-right', threats.some((enemy) => enemy.side > 0));
    const cars = [...new Set(threats.map((enemy) => enemy.targetCar + 1))].sort((a, b) => a - b);
    const carLabel = cars.length === 1 ? ` · CAR ${cars[0]}` : cars.length > 1 ? ` · CARS ${cars.join('/')}` : '';
    const label = compass.querySelector('span');
    if (label) label.textContent = `${threats.length} BOARDER${threats.length === 1 ? '' : 'S'}${carLabel}`;
  }

  private renderPower(state: GameState): void {
    this.bindText('power-production', `${Math.round(state.powerProduction)} kW`);
    this.bindText('power-load', `${Math.round(state.powerDraw)} / ${Math.round(state.powerProduction)}`);
    this.bindText('power-battery', `${Math.round((state.battery / Math.max(1, state.maxBattery)) * 100)}%`);
    this.bindStyle('load-needle', 'transform', `rotate(${(-54 + clamp(state.powerDraw / Math.max(1, state.powerProduction), 0, 1.35) / 1.35 * 108).toFixed(1)}deg)`);
    const overloaded = state.powerDraw > state.powerProduction;
    this.bindText('power-status', overloaded ? '⚠ GRID OVERLOAD — ACCUMULATOR DRAIN' : state.alarm ? '⚠ LOAD UNSTABLE — DAMAGE DETECTED' : 'GRID WITHIN TOLERANCE');
    this.powerPanel.classList.toggle('is-overloaded', overloaded);

    const schematic = this.required<HTMLElement>('[data-bind="schematic"]');
    for (const [index, id] of SYSTEM_ORDER.entries()) {
      const system = state.systems[id];
      if (!system) continue;
      let circuit = schematic.querySelector<HTMLElement>(`[data-circuit="${id}"]`);
      if (!circuit) {
        circuit = this.createCircuit(system, index);
        schematic.append(circuit);
      }
      circuit.classList.toggle('is-on', system.powered);
      circuit.classList.toggle('is-fault', system.damaged);
      circuit.style.setProperty('--health', `${clamp(system.health)}%`);
      const toggle = circuit.querySelector<HTMLButtonElement>('button[data-system]');
      toggle?.setAttribute('aria-pressed', String(system.powered));
      toggle?.classList.toggle('is-on', system.powered);
      const healthLabel = circuit.querySelector<HTMLElement>('[data-circuit-health]');
      if (healthLabel) healthLabel.textContent = system.damaged ? `${Math.round(system.health)}% · ${system.damageKind ?? 'fault'}` : `${Math.round(system.health)}% integrity`;
      const drawLabel = circuit.querySelector<HTMLElement>('[data-circuit-draw]');
      if (drawLabel) drawLabel.textContent = `${system.draw} kW`;
    }
  }

  private createCircuit(system: TrainSystemState, index: number): HTMLElement {
    const article = document.createElement('article');
    article.className = 'circuit';
    article.dataset.circuit = system.id;
    article.style.setProperty('--circuit-index', String(index));
    article.innerHTML = `<div class="circuit-line" aria-hidden="true"><i></i><b></b></div>`;
    const label = document.createElement('div');
    label.className = 'circuit-label';
    label.append(text('span', '', `C${String(index + 1).padStart(2, '0')}`), text('strong', '', system.label), text('small', '', ''));
    label.querySelector('small')!.dataset.circuitHealth = '';
    const switchButton = document.createElement('button');
    switchButton.type = 'button';
    switchButton.className = 'knife-switch';
    switchButton.dataset.system = system.id;
    switchButton.setAttribute('aria-label', `Toggle ${system.label} power`);
    switchButton.innerHTML = '<span></span><i></i>';
    const load = text('strong', 'circuit-draw', `${system.draw} kW`);
    load.dataset.circuitDraw = '';
    article.append(label, switchButton, load);
    return article;
  }

  private renderStation(state: GameState): void {
    this.bindText('station-title', state.stationName || 'Gallowglass Depot');
    this.bindText('station-scrap', String(Math.floor(state.scrap)));
    const missingHull = Math.max(0, 100 - state.hull);
    const damagedSystems = Object.values(state.systems).filter((system) => system.damaged).length;
    const repairCost = 12;
    const needsRepair = missingHull >= 1 || damagedSystems > 0;
    this.bindText('repair-cost', `${repairCost} ⦿`);
    this.bindText(
      'repair-copy',
      missingHull >= 1
        ? `${Math.round(missingHull)}% structural loss · ${damagedSystems} circuit fault${damagedSystems === 1 ? '' : 's'}.`
        : damagedSystems > 0
          ? `${damagedSystems} damaged circuit${damagedSystems === 1 ? '' : 's'} logged for overhaul.`
          : 'No structural or circuit work required.',
    );
    const repairButton = this.required<HTMLButtonElement>('[data-action="repair-train"]');
    repairButton.disabled = !needsRepair || state.scrap < repairCost;

    const upgrades = this.required<HTMLElement>('[data-bind="upgrades"]');
    upgrades.replaceChildren(...state.upgrades.slice(0, 6).map((upgrade, index) => this.createUpgradeCard(upgrade, index, state.scrap)));
    const passengers = this.required<HTMLElement>('[data-bind="passengers"]');
    passengers.replaceChildren(...state.passengers.slice(0, 3).map((passenger, index) => this.createPassengerCard(passenger, index)));
    if (!state.passengers.length) passengers.append(text('p', 'station-empty', 'No crew members are currently assigned to this train.'));

    const dealCard = this.required<HTMLElement>('[data-bind="deal-card"]');
    dealCard.classList.toggle('is-resolved', state.dealTaken);
    dealCard.querySelectorAll('button').forEach((button) => { button.disabled = state.dealTaken; });
    if (state.dealTaken) {
      const stamp = dealCard.querySelector('.deal-card__stamp');
      if (stamp) stamp.textContent = 'INSTALLED · CONSEQUENCE PENDING';
    }
  }

  private createUpgradeCard(upgrade: UpgradeState, index: number, scrap: number): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'upgrade-card';
    button.dataset.upgrade = upgrade.id;
    button.disabled = upgrade.purchased || upgrade.cost > scrap;
    button.classList.toggle('is-purchased', upgrade.purchased);
    const indexLabel = text('span', 'upgrade-card__index', String(index + 1).padStart(2, '0'));
    const copy = document.createElement('span');
    copy.className = 'upgrade-card__copy';
    copy.append(text('strong', '', upgrade.label), text('small', '', upgrade.description));
    const cost = text('b', '', upgrade.purchased ? 'FITTED' : `${upgrade.cost} ⦿`);
    button.append(indexLabel, copy, cost);
    return button;
  }

  private createPassengerCard(passenger: PassengerState, index: number): HTMLElement {
    const article = document.createElement('article');
    article.className = 'passenger-card';
    article.setAttribute('aria-label', `${passenger.name}, onboard ${passenger.profession}`);
    const portrait = text('div', 'passenger-portrait', passenger.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase());
    portrait.setAttribute('aria-hidden', 'true');
    portrait.style.setProperty('--portrait-hue', String(28 + index * 29));
    const identity = document.createElement('div');
    identity.className = 'passenger-identity';
    const activity = this.passengerActivity(passenger);
    identity.append(text('small', '', `ONBOARD · ${passenger.profession}`), text('h4', '', passenger.name), text('span', 'passenger-activity', activity));
    const traits = document.createElement('dl');
    traits.innerHTML = '<div><dt>ROLE</dt></div><div><dt>WATCH FOR</dt></div>';
    traits.children[0].append(text('dd', '', passenger.ability));
    traits.children[1].append(text('dd', '', passenger.weakness));
    const meters = document.createElement('div');
    meters.className = 'passenger-meters';
    meters.setAttribute('aria-label', `${passenger.name} crew condition`);
    meters.append(
      this.miniMeter('LOYALTY', passenger.loyalty),
      this.miniMeter('MORALE', passenger.morale),
      this.miniMeter('HEALTH', passenger.health),
    );
    const choices = document.createElement('div');
    choices.className = 'passenger-choices';
    const support = this.passengerChoiceButton(passenger, 'support');
    const challenge = this.passengerChoiceButton(passenger, 'challenge');
    const lastBriefingVisit = (passenger as PassengerState & { lastBriefingVisit?: number }).lastBriefingVisit;
    const alreadyBriefed = lastBriefingVisit === this.state?.stationVisits;
    support.disabled = alreadyBriefed;
    challenge.disabled = alreadyBriefed;
    if (alreadyBriefed) {
      support.querySelector('strong')!.textContent = 'Briefing logged';
      support.querySelector('small')!.textContent = 'next check-in at the following stop';
      support.classList.add('is-logged');
      challenge.hidden = true;
    }
    choices.append(support, challenge);
    article.append(portrait, identity, traits, meters, choices);
    return article;
  }

  private passengerActivity(passenger: PassengerState): string {
    const activity = (passenger as PassengerState & { activity?: string }).activity;
    if (!activity) return 'STANDING WATCH';
    return activity.replace(/-/g, ' ').toUpperCase();
  }

  private passengerChoiceButton(passenger: PassengerState, choice: PassengerBriefingChoice): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.passenger = passenger.id;
    button.dataset.passengerChoice = choice;
    const profession = passenger.profession.toLowerCase();
    const labels = choice === 'support'
      ? profession.includes('engineer') ? ['Back her repair plan', '+7 loyalty · +3 morale']
        : profession.includes('doctor') ? ['Protect the infirmary', '+6 loyalty · +5 morale']
          : ['Trust his firing call', '+8 loyalty · +2 morale']
      : profession.includes('engineer') ? ['Challenge her limits', '−2 loyalty · +8 morale']
        : profession.includes('doctor') ? ['Challenge his caution', '+2 loyalty · −4 morale']
          : ['Challenge his nerve', '−3 loyalty · +9 morale'];
    button.innerHTML = `<strong>${labels[0]}</strong><small>${labels[1]}</small>`;
    button.setAttribute('aria-label', `${labels[0]} for ${passenger.name}. Consequence: ${labels[1].replace(/−/g, 'minus ')}.`);
    return button;
  }

  private miniMeter(label: string, value: number): HTMLElement {
    const meter = document.createElement('div');
    const safeValue = Math.round(clamp(value));
    const condition = this.crewCondition(label, safeValue);
    meter.className = `crew-meter is-${condition.tone}`;
    meter.append(text('span', '', label));
    const track = document.createElement('i');
    track.style.setProperty('--value', `${safeValue}%`);
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', label.toLocaleLowerCase());
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(safeValue));
    track.setAttribute('aria-valuetext', `${safeValue} percent, ${condition.label}`);
    meter.append(track, text('b', '', String(safeValue)), text('small', '', condition.label));
    return meter;
  }

  private crewCondition(label: string, value: number): { label: string; tone: 'good' | 'steady' | 'warning' | 'critical' } {
    if (label === 'LOYALTY') {
      if (value >= 75) return { label: 'DEVOTED', tone: 'good' };
      if (value >= 50) return { label: 'TRUSTED', tone: 'steady' };
      if (value >= 25) return { label: 'GUARDED', tone: 'warning' };
      return { label: 'WAVERING', tone: 'critical' };
    }
    if (label === 'MORALE') {
      if (value >= 75) return { label: 'RESOLUTE', tone: 'good' };
      if (value >= 50) return { label: 'STEADY', tone: 'steady' };
      if (value >= 25) return { label: 'SHAKEN', tone: 'warning' };
      return { label: 'BREAKING', tone: 'critical' };
    }
    if (value >= 75) return { label: 'FIT', tone: 'good' };
    if (value >= 50) return { label: 'HURT', tone: 'steady' };
    if (value >= 25) return { label: 'WOUNDED', tone: 'warning' };
    return { label: 'CRITICAL', tone: 'critical' };
  }

  private formatRepairPrompt(hint?: string): { key: string; instruction: string } {
    if (!hint) return { key: 'E', instruction: 'Hold steady to complete this step' };
    const parts = hint.split('·').map((part) => part.trim()).filter(Boolean);
    const hasKey = Boolean(parts[0]?.match(/^[A-Z0-9]{1,8}$/i));
    const key = hasKey ? parts.shift()!.toUpperCase() : 'E';
    const instruction = parts.join(' · ')
      .replace(/step\s+(\d+)\/(\d+)/i, 'Step $1 of $2')
      .replace(/equip\s+(wrench|sidearm|arc-tool)/i, (_match, equipment: keyof typeof EQUIPMENT_LABELS) => `${EQUIPMENT_LABELS[equipment]} required`);
    return { key, instruction: instruction || (hasKey ? 'Hold steady to complete this step' : hint) };
  }

  private renderGameOver(state: GameState): void {
    this.bindText('report-seed', `RUN ${String(state.seed).slice(-6).padStart(6, '0')}`);
    this.bindText('gameover-reason', state.gameOverReason || 'The train was lost to the ash.');
    this.bindText('summary-time', formatDuration(state.elapsed));
    this.bindText('summary-regions', String(Math.max(0, state.region)));
    this.bindText('summary-enemies', this.runSummary.enemiesRepelled == null ? '—' : String(this.runSummary.enemiesRepelled));
    this.bindText('summary-repairs', this.runSummary.repairsCompleted == null ? '—' : String(this.runSummary.repairsCompleted));
    this.bindText('summary-passengers', String(this.runSummary.passengersSaved ?? state.passengers.length));
    this.bindText('summary-hull', `${Math.max(0, Math.round(state.hull))}%`);
  }

  private updateQualityButtons(): void {
    this.shell.querySelectorAll<HTMLButtonElement>('[data-quality]').forEach((button) => {
      const selected = button.dataset.quality === this.quality;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  private bindText(name: string, value: string): void {
    this.shell.querySelectorAll<HTMLElement>(`[data-bind="${name}"]`).forEach((element) => {
      if (element.textContent !== value) element.textContent = value;
    });
  }

  private bindStyle(name: string, property: string, value: string): void {
    this.shell.querySelectorAll<HTMLElement>(`[data-bind="${name}"]`).forEach((element) => {
      element.style.setProperty(property, value);
    });
  }

  private required<T extends HTMLElement = HTMLElement>(selector: string, parent: ParentNode = this.shell): T {
    const element = parent.querySelector<T>(selector);
    if (!element) throw new Error(`GameUI could not find ${selector}`);
    return element;
  }
}

export default GameUI;
