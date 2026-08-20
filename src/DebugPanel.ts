import type { EnemyType, GameState, SystemId } from './shared/types';

export interface DebugActions {
  teleport(carIndex: number): void;
  damageSystem(id: SystemId): void;
  setPowerProduction(amount: number): void;
  spawnEnemy(type: EnemyType): void;
  skipToStation(): void;
  grantScrap(amount: number): void;
  changeSpeed(amount: number): void;
  toggleColliders(): void;
}

export class DebugPanel {
  private readonly element: HTMLElement;
  private readonly readout: HTMLElement;
  private visible = false;

  constructor(private readonly actions: DebugActions) {
    this.element = document.createElement('aside');
    this.element.id = 'debug-panel';
    this.element.setAttribute('aria-label', 'Developer debug panel');
    this.element.innerHTML = `
      <style>
        #debug-panel{position:fixed;right:12px;top:12px;z-index:80;width:290px;padding:12px;border:1px solid #bb9250;background:#090d10ee;color:#dfc99a;font:11px/1.4 ui-monospace,SFMono-Regular,monospace;box-shadow:0 8px 40px #000;display:none}
        #debug-panel.open{display:block}#debug-panel h2{font:700 13px/1 sans-serif;letter-spacing:.18em;margin:0 0 10px;color:#f2d184}
        #debug-panel section{display:flex;flex-wrap:wrap;gap:5px;margin:7px 0}#debug-panel button{border:1px solid #685631;background:#1b2225;color:#d9c494;padding:5px 7px;cursor:pointer;font:inherit}
        #debug-panel button:hover{background:#39423e;color:#fff}#debug-panel pre{margin:8px 0 0;max-height:180px;overflow:auto;color:#96c4b8;white-space:pre-wrap}
      </style>
      <h2>CONDUCTOR // DEV</h2>
      <section data-group="cars"></section>
      <section data-group="damage"></section>
      <section data-group="spawn"></section>
      <section data-group="utility"></section>
      <pre></pre>`;
    document.body.append(this.element);
    this.readout = this.element.querySelector('pre')!;
    this.fillButtons();
    window.addEventListener('keydown', this.onKey);
  }

  update(state: GameState, rendererInfo?: { calls?: number; triangles?: number; geometries?: number; textures?: number }): void {
    if (!this.visible) return;
    const ai = state.enemies.map((enemy) => `${enemy.type}#${enemy.id} ${enemy.stage} hp:${Math.round(enemy.health)}`).join('\n') || 'no active boarders';
    this.readout.textContent = [
      `mode ${state.mode} | region ${state.region} | seed ${state.seed}`,
      `player car ${state.player.carIndex + 1} x:${state.player.position.x.toFixed(1)} z:${state.player.position.z.toFixed(1)}`,
      `speed ${state.speed.toFixed(0)} | power ${state.powerDraw}/${state.powerProduction} | hull ${state.hull.toFixed(0)}`,
      `draws ${rendererInfo?.calls ?? '-'} | tris ${rendererInfo?.triangles ?? '-'} | geo ${rendererInfo?.geometries ?? '-'} | tex ${rendererInfo?.textures ?? '-'}`,
      ai,
    ].join('\n');
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey);
    this.element.remove();
  }

  private fillButtons(): void {
    const cars = this.element.querySelector('[data-group="cars"]')!;
    ['LOCO', 'POWER', 'PAX', 'DEFENSE'].forEach((label, index) => cars.append(this.button(label, () => this.actions.teleport(index))));

    const damage = this.element.querySelector('[data-group="damage"]')!;
    (['engine', 'cooling', 'locks', 'turret'] as SystemId[]).forEach((id) => damage.append(this.button(`BREAK ${id}`, () => this.actions.damageSystem(id))));

    const spawn = this.element.querySelector('[data-group="spawn"]')!;
    (['clinger', 'leeche', 'ripper'] as EnemyType[]).forEach((type) => spawn.append(this.button(`SPAWN ${type}`, () => this.actions.spawnEnemy(type))));

    const utility = this.element.querySelector('[data-group="utility"]')!;
    utility.append(
      this.button('+20 POWER', () => this.actions.setPowerProduction(20)),
      this.button('+50 SCRAP', () => this.actions.grantScrap(50)),
      this.button('+SPEED', () => this.actions.changeSpeed(15)),
      this.button('STATION', () => this.actions.skipToStation()),
      this.button('COLLIDERS', () => this.actions.toggleColliders()),
    );
  }

  private button(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  private onKey = (event: KeyboardEvent): void => {
    if (event.code !== 'Backquote') return;
    this.visible = !this.visible;
    this.element.classList.toggle('open', this.visible);
  };
}

