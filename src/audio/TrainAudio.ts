import type { EquipmentId, GameState, GameplayEvents, SystemId } from '../shared/types';

interface VoiceSlot {
  input: GainNode;
  gain: GainNode;
  pan: StereoPannerNode;
  filter: BiquadFilterNode;
  busyUntil: number;
  sources: AudioScheduledSourceNode[];
}

interface ContinuousGraph {
  master: GainNode;
  engineGain: GainNode;
  wheelGain: GainNode;
  windGain: GainNode;
  rattleGain: GainNode;
  machineryGain: GainNode;
  alarmGain: GainNode;
  musicGain: GainNode;
  exteriorPan: StereoPannerNode;
  sources: AudioScheduledSourceNode[];
  modulators: AudioScheduledSourceNode[];
}

const nowWithLead = (context: AudioContext) => context.currentTime + 0.008;

export class TrainAudio {
  private context?: AudioContext;
  private graph?: ContinuousGraph;
  private voices: VoiceSlot[] = [];
  private noiseBuffer?: AudioBuffer;
  private unlocked = false;
  private muted = false;
  private masterVolume = 0.76;
  private lastElapsed = 0;
  private railDistance = 0;
  private footstepDistance = 0;
  private footstepSide = -1;
  private previousPower = new Map<SystemId, boolean>();
  private previousAlarm = false;
  private previousMode: GameState['mode'] = 'title';
  private previousMountedTurret = false;
  private previousDodging = false;

  get isUnlocked() { return this.unlocked; }

  async unlock() {
    if (!this.context) this.initialize();
    if (!this.context) return;
    if (this.context.state !== 'running') await this.context.resume();
    this.unlocked = this.context.state === 'running';
  }

  private initialize() {
    const Context = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    const context = new Context({ latencyHint: 'interactive' });
    this.context = context;
    this.noiseBuffer = this.makeNoiseBuffer(context, 3);
    const master = context.createGain();
    master.gain.value = this.muted ? 0 : this.masterVolume;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 8;
    limiter.ratio.value = 9;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    master.connect(limiter).connect(context.destination);

    const engineGain = context.createGain();
    const wheelGain = context.createGain();
    const windGain = context.createGain();
    const rattleGain = context.createGain();
    const machineryGain = context.createGain();
    const alarmGain = context.createGain();
    const musicGain = context.createGain();
    const exteriorPan = context.createStereoPanner();
    [engineGain, wheelGain, rattleGain, machineryGain, alarmGain, musicGain].forEach((node) => node.connect(master));
    windGain.connect(exteriorPan).connect(master);
    engineGain.gain.value = wheelGain.gain.value = windGain.gain.value = rattleGain.gain.value = machineryGain.gain.value = alarmGain.gain.value = musicGain.gain.value = 0;
    const sources: AudioScheduledSourceNode[] = [];
    const modulators: AudioScheduledSourceNode[] = [];

    const connectOscillator = (frequency: number, type: OscillatorType, destination: AudioNode, amount: number, detune = 0) => {
      const oscillator = context.createOscillator();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      oscillator.detune.value = detune;
      const gain = context.createGain();
      gain.gain.value = amount;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      sources.push(oscillator);
      return oscillator;
    };

    const engineFilter = context.createBiquadFilter();
    engineFilter.type = 'lowpass'; engineFilter.frequency.value = 240; engineFilter.Q.value = 2.1;
    engineFilter.connect(engineGain);
    const engineBase = connectOscillator(31, 'sawtooth', engineFilter, 0.36);
    const engineHarmonic = connectOscillator(62, 'square', engineFilter, 0.07, -4);
    const engineLfo = context.createOscillator();
    const engineMod = context.createGain();
    engineLfo.frequency.value = 2.1;
    engineMod.gain.value = 0.045;
    engineLfo.connect(engineMod).connect(engineGain.gain);
    engineLfo.start();
    modulators.push(engineLfo);

    const wheelNoise = this.loopNoise(context, wheelGain, 0.22, 'bandpass', 780, 1.15);
    const windNoise = this.loopNoise(context, windGain, 0.26, 'highpass', 620, 0.3);
    const rattleNoise = this.loopNoise(context, rattleGain, 0.12, 'bandpass', 2500, 6.5);
    sources.push(wheelNoise, windNoise, rattleNoise);
    const generator = connectOscillator(54.5, 'sine', machineryGain, 0.12);
    connectOscillator(109, 'triangle', machineryGain, 0.045, 4);
    const alarmOsc = connectOscillator(720, 'square', alarmGain, 0.12);
    const alarmLfo = context.createOscillator();
    const alarmMod = context.createGain();
    alarmLfo.type = 'square'; alarmLfo.frequency.value = 2.7; alarmMod.gain.value = 0.18;
    alarmLfo.connect(alarmMod).connect(alarmGain.gain); alarmLfo.start(); modulators.push(alarmLfo);
    // Restrained minor-sixth drone gives threat modulation without covering machinery.
    const musicFilter = context.createBiquadFilter();
    musicFilter.type = 'lowpass'; musicFilter.frequency.value = 370; musicFilter.Q.value = 1.3;
    musicFilter.connect(musicGain);
    connectOscillator(55, 'triangle', musicFilter, 0.08);
    connectOscillator(65.41, 'sine', musicFilter, 0.034, -5);
    connectOscillator(82.41, 'sine', musicFilter, 0.025, 3);
    // Expose continuous oscillators through graph-owned source list for deterministic teardown.
    (engineBase as OscillatorNode & { _role?: string })._role = 'engine-base';
    (engineHarmonic as OscillatorNode & { _role?: string })._role = 'engine-harmonic';
    (generator as OscillatorNode & { _role?: string })._role = 'generator';
    (alarmOsc as OscillatorNode & { _role?: string })._role = 'alarm';

    this.graph = { master, engineGain, wheelGain, windGain, rattleGain, machineryGain, alarmGain, musicGain, exteriorPan, sources, modulators };
    for (let i = 0; i < 18; i += 1) this.voices.push(this.createVoice(context, master));
  }

  private makeNoiseBuffer(context: AudioContext, seconds: number) {
    const length = Math.floor(context.sampleRate * seconds);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const channel = buffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      brown = (brown + white * 0.075) / 1.075;
      channel[i] = white * 0.62 + brown * 0.38;
    }
    return buffer;
  }

  private loopNoise(context: AudioContext, destination: AudioNode, gainValue: number, type: BiquadFilterType, frequency: number, q: number) {
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer!;
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = type; filter.frequency.value = frequency; filter.Q.value = q;
    const gain = context.createGain(); gain.gain.value = gainValue;
    source.connect(filter).connect(gain).connect(destination);
    source.start(0, Math.random() * 2);
    return source;
  }

  private createVoice(context: AudioContext, destination: AudioNode): VoiceSlot {
    const input = context.createGain();
    const filter = context.createBiquadFilter();
    const pan = context.createStereoPanner();
    const gain = context.createGain();
    input.connect(filter).connect(pan).connect(gain).connect(destination);
    gain.gain.value = 0;
    return { input, filter, pan, gain, busyUntil: 0, sources: [] };
  }

  private claimVoice(duration: number, pan = 0) {
    const context = this.context!;
    const now = context.currentTime;
    const voice = this.voices.find((slot) => slot.busyUntil <= now) ?? this.voices.reduce((a, b) => a.busyUntil < b.busyUntil ? a : b);
    voice.sources.forEach((source) => { try { source.stop(); } catch { /* already ended */ } });
    voice.sources.length = 0;
    voice.busyUntil = now + duration;
    voice.pan.pan.cancelScheduledValues(now);
    voice.pan.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), now);
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(0, now);
    return voice;
  }

  private tone(frequency: number, duration: number, volume: number, type: OscillatorType = 'sine', pan = 0, slide = 1, filter = 4200) {
    const context = this.context;
    if (!context || !this.unlocked) return;
    const voice = this.claimVoice(duration + 0.05, pan);
    const time = nowWithLead(context);
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, time);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(16, frequency * slide), time + duration);
    voice.filter.type = 'lowpass'; voice.filter.frequency.setValueAtTime(filter, time); voice.filter.Q.value = 0.8;
    voice.gain.gain.setValueAtTime(0.0001, time);
    voice.gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), time + Math.min(0.015, duration * 0.15));
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    oscillator.connect(voice.input);
    oscillator.start(time); oscillator.stop(time + duration + 0.01);
    voice.sources.push(oscillator);
  }

  private noise(duration: number, volume: number, pan = 0, frequency = 1300, type: BiquadFilterType = 'bandpass') {
    const context = this.context;
    if (!context || !this.unlocked || !this.noiseBuffer) return;
    const voice = this.claimVoice(duration + 0.05, pan);
    const time = nowWithLead(context);
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = 0.72 + Math.random() * 0.55;
    voice.filter.type = type; voice.filter.frequency.value = frequency; voice.filter.Q.value = type === 'bandpass' ? 1.8 : 0.7;
    voice.gain.gain.setValueAtTime(Math.max(0.0001, volume), time);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    source.connect(voice.input);
    source.start(time, Math.random() * 1.8, duration); source.stop(time + duration + 0.01);
    voice.sources.push(source);
  }

  private railJoint(speed: number) {
    const level = Math.min(0.23, 0.055 + speed * 0.0022);
    this.tone(72, 0.095, level, 'sine', (Math.random() - 0.5) * 0.18, 0.46, 600);
    this.noise(0.045, level * 0.5, 0, 2100, 'bandpass');
  }

  private combatCue(equipment: EquipmentId) {
    if (equipment === 'sidearm') {
      this.noise(0.16, 0.34, 0.08, 1350, 'highpass');
      this.tone(118, 0.2, 0.28, 'sawtooth', 0.08, 0.2, 1700);
    } else if (equipment === 'arc-tool') {
      this.tone(1040, 0.19, 0.2, 'square', 0.12, 0.36, 3300);
      this.noise(0.22, 0.22, 0.12, 4200, 'bandpass');
      this.tone(76, 0.24, 0.18, 'sine', 0.05, 0.55, 900);
    } else {
      this.noise(0.1, 0.2, 0.15, 520, 'lowpass');
      this.tone(88, 0.12, 0.18, 'triangle', 0.15, 0.52, 800);
    }
  }

  private footstepCue(sprinting: boolean) {
    this.footstepSide *= -1;
    const pan = this.footstepSide * 0.08;
    this.noise(sprinting ? 0.065 : 0.05, sprinting ? 0.09 : 0.055, pan, sprinting ? 520 : 690, 'bandpass');
    this.tone(sprinting ? 72 : 86, 0.085, sprinting ? 0.09 : 0.055, 'sine', pan, 0.48, 420);
  }

  private turretCue() {
    // A mounted gun needs much more weight than the handheld sidearm: a short
    // mechanical crack, a deep breech thump, and a bright barrel report.
    this.noise(0.24, 0.48, 0, 980, 'highpass');
    this.tone(58, 0.46, 0.42, 'sawtooth', 0, 0.19, 620);
    this.tone(182, 0.16, 0.2, 'square', 0, 0.38, 1900);
  }

  update(state: GameState, events?: GameplayEvents) {
    if (!this.context || !this.graph || !this.unlocked) return;
    const context = this.context;
    const graph = this.graph;
    const now = context.currentTime;
    const dt = Math.max(0, Math.min(0.1, state.elapsed - this.lastElapsed || 1 / 60));
    this.lastElapsed = state.elapsed;
    const speed = Math.max(0, state.speed);
    const smooth = (param: AudioParam, value: number, duration = 0.12) => param.setTargetAtTime(value, now, duration);
    smooth(graph.engineGain.gain, state.mode === 'station' || state.mode === 'title' ? 0.022 : 0.09 + speed * 0.0019);
    smooth(graph.wheelGain.gain, speed < 2 ? 0 : 0.045 + speed * 0.0014);
    smooth(graph.windGain.gain, speed < 3 ? 0.015 : 0.018 + speed * 0.0015 + state.threatLevel * 0.003);
    smooth(graph.rattleGain.gain, speed < 2 ? 0.004 : 0.025 + speed * 0.0008);
    const engineeringMix = state.player.carIndex === 1 ? 1 : 0.4;
    smooth(graph.machineryGain.gain, state.systems.engine.powered ? 0.095 * engineeringMix : 0.008);
    smooth(graph.alarmGain.gain, state.alarm ? 0.14 : 0, 0.04);
    const threatMusic = state.mode === 'station' ? 0.04 : state.mode === 'gameover' ? 0.075 : Math.max(0, state.threatLevel - 3) * 0.007;
    smooth(graph.musicGain.gain, threatMusic, 0.8);
    graph.exteriorPan.pan.setTargetAtTime(state.player.position.x / 7, now, 0.2);
    // Pitch and playback-rate scaling produce a restrained exterior Doppler illusion.
    graph.sources.forEach((source) => {
      if (source instanceof AudioBufferSourceNode) source.playbackRate.setTargetAtTime(0.72 + speed / 115, now, 0.2);
      if (source instanceof OscillatorNode) {
        const role = (source as OscillatorNode & { _role?: string })._role;
        if (role === 'engine-base') source.frequency.setTargetAtTime(25 + speed * 0.21, now, 0.2);
        else if (role === 'engine-harmonic') source.frequency.setTargetAtTime(50 + speed * 0.42, now, 0.2);
        else if (role === 'generator') source.frequency.setTargetAtTime(52 + state.powerDraw * 0.06, now, 0.18);
      }
    });
    this.railDistance += speed * dt;
    while (this.railDistance >= 2.2) { this.railDistance -= 2.2; this.railJoint(speed); }
    if (state.mode === 'travel' && state.player.moveSpeed > 0.45 && !state.player.dodging) {
      this.footstepDistance += state.player.moveSpeed * dt;
      const stride = state.player.sprinting ? 1.15 : state.player.aiming ? 0.72 : 0.88;
      while (this.footstepDistance >= stride) {
        this.footstepDistance -= stride;
        this.footstepCue(state.player.sprinting);
      }
    } else {
      this.footstepDistance = Math.min(this.footstepDistance, 0.3);
    }
    if (state.player.dodging && !this.previousDodging) {
      this.noise(0.18, 0.12, 0, 1100, 'bandpass');
      this.tone(64, 0.16, 0.08, 'sine', 0, 0.38, 520);
    }
    this.previousDodging = state.player.dodging;

    if (events?.turretFired) this.turretCue();
    else if (events?.shot) this.combatCue(events.shot);
    if (state.mountedTurretActive !== this.previousMountedTurret) {
      this.tone(state.mountedTurretActive ? 126 : 82, 0.32, 0.11, 'sawtooth', 0, state.mountedTurretActive ? 1.42 : 0.58, 950);
      this.noise(0.16, 0.07, 0, 520, 'bandpass');
      this.previousMountedTurret = state.mountedTurretActive;
    }
    if (events?.enemyHit) {
      const enemy = state.enemies.find((candidate) => candidate.id === events.enemyHit?.id);
      const pan = enemy ? Math.max(-1, Math.min(1, enemy.side * 0.66)) : 0;
      this.noise(0.12, 0.18, pan, enemy?.type === 'ripper' ? 340 : 940, 'bandpass');
      this.tone(enemy?.type === 'leeche' ? 620 : 96, 0.16, 0.13, 'sawtooth', pan, 0.64, 1800);
    }
    if (events?.impact) {
      const weight = Math.min(1, events.impact / 20);
      this.tone(42, 0.48, 0.32 * weight, 'sine', (Math.random() - 0.5) * 0.6, 0.44, 260);
      this.noise(0.28, 0.24 * weight, 0, 380, 'lowpass');
    }
    if (events?.stationReached || (state.mode === 'station' && this.previousMode !== 'station')) {
      [220, 277.18, 329.63].forEach((frequency, index) => this.tone(frequency, 1.8 + index * 0.2, 0.055, 'sine', 0, 0.995, 900));
    }

    (Object.keys(state.systems) as SystemId[]).forEach((id) => {
      const on = state.systems[id].powered;
      const previous = this.previousPower.get(id);
      if (previous !== undefined && previous !== on) {
        const pan = id === 'radar' || id === 'medical' ? 0.35 : id === 'cooling' ? 0.55 : 0;
        this.tone(on ? 196 : 92, on ? 0.22 : 0.34, 0.08, on ? 'sine' : 'triangle', pan, on ? 1.45 : 0.48, 1200);
        this.noise(0.04, 0.04, pan, 2300, 'highpass');
      }
      this.previousPower.set(id, on);
    });
    if (state.alarm && !this.previousAlarm) {
      this.tone(880, 0.13, 0.12, 'square', 0, 0.96, 2100);
      this.tone(660, 0.2, 0.1, 'square', 0, 0.96, 1800);
    }
    this.previousAlarm = state.alarm;
    this.previousMode = state.mode;
  }

  setMasterVolume(value: number) {
    this.masterVolume = Math.max(0, Math.min(1, value));
    if (this.context && this.graph) this.graph.master.gain.setTargetAtTime(this.muted ? 0 : this.masterVolume, this.context.currentTime, 0.04);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.context && this.graph) this.graph.master.gain.setTargetAtTime(muted ? 0 : this.masterVolume, this.context.currentTime, 0.025);
  }

  async dispose() {
    this.unlocked = false;
    this.voices.forEach((voice) => {
      voice.sources.forEach((source) => { try { source.stop(); } catch { /* source ended */ } });
      voice.input.disconnect(); voice.filter.disconnect(); voice.pan.disconnect(); voice.gain.disconnect();
    });
    this.voices.length = 0;
    this.graph?.sources.forEach((source) => { try { source.stop(); } catch { /* source ended */ } });
    this.graph?.modulators.forEach((source) => { try { source.stop(); } catch { /* source ended */ } });
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.graph = undefined;
    this.context = undefined;
  }
}
