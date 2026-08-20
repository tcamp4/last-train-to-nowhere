import type { InputSnapshot } from './shared/types';

const preventable = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export class InputController {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private primaryHeld = false;
  private secondaryHeld = false;
  private primaryPressed = false;
  private mouseDX = 0;
  private mouseDY = 0;
  private wheel = 0;
  private enabled = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('blur', this.clear);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('click', this.onCanvasClick);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  isPointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  requestPointerLock(): void {
    if (!this.enabled || this.isPointerLocked()) return;
    try {
      const request = this.canvas.requestPointerLock();
      if (request && typeof request.catch === 'function') void request.catch(() => undefined);
    } catch {
      // Pointer lock is optional in embedded/headless documents; drag-look still works.
    }
  }

  snapshot(): InputSnapshot {
    const active = this.enabled;
    const snapshot: InputSnapshot = {
      forward: active ? Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) - Number(this.keys.has('KeyS') || this.keys.has('ArrowDown')) : 0,
      strafe: active ? Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft')) : 0,
      sprint: active && (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')),
      dodgePressed: active && this.pressed.has('Space'),
      reloadPressed: active && this.pressed.has('KeyR'),
      interactPressed: active && this.pressed.has('KeyE'),
      primaryPressed: active && this.primaryPressed,
      primaryHeld: active && this.primaryHeld,
      secondaryHeld: active && this.secondaryHeld,
      tabPressed: active && this.pressed.has('Tab'),
      pausePressed: active && this.pressed.has('Escape'),
      equipmentDelta: active ? Math.sign(this.wheel) : 0,
      numberSelect: active ? this.numberSelection() : 0,
      cameraDeltaX: active ? this.mouseDX : 0,
      cameraDeltaY: active ? this.mouseDY : 0,
    };
    this.pressed.clear();
    this.primaryPressed = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    return snapshot;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('blur', this.clear);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('click', this.onCanvasClick);
  }

  private numberSelection(): number {
    if (this.pressed.has('Digit1')) return 1;
    if (this.pressed.has('Digit2')) return 2;
    if (this.pressed.has('Digit3')) return 3;
    return 0;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    if (preventable.has(event.code)) event.preventDefault();
    this.keys.add(event.code);
    this.pressed.add(event.code);
    if (event.code === 'KeyF') {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void this.canvas.parentElement?.requestFullscreen();
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.enabled || (!this.isPointerLocked() && event.buttons === 0)) return;
    this.mouseDX += event.movementX;
    this.mouseDY += event.movementY;
  };

  private onMouseDown = (event: MouseEvent): void => {
    if (!this.enabled || event.target !== this.canvas) return;
    if (event.button === 0) {
      this.primaryHeld = true;
      this.primaryPressed = true;
    }
    if (event.button === 2) this.secondaryHeld = true;
  };

  private onMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) this.primaryHeld = false;
    if (event.button === 2) this.secondaryHeld = false;
  };

  private onWheel = (event: WheelEvent): void => {
    if (!this.enabled || event.target !== this.canvas) return;
    event.preventDefault();
    this.wheel += event.deltaY;
  };

  private onCanvasClick = (): void => this.requestPointerLock();
  private onContextMenu = (event: MouseEvent): void => event.preventDefault();
  private clear = (): void => {
    this.keys.clear();
    this.pressed.clear();
    this.primaryHeld = false;
    this.secondaryHeld = false;
    this.primaryPressed = false;
  };
}
