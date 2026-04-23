import { generateName } from './names.mjs';
import { WORLD_WIDTH, WORLD_HEIGHT, TERRAIN } from './config.mjs';

const COLORS = ['magenta','cyan','yellow','green','red','blue','white'];
let colorIdx = 0;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export class Entity {
  constructor(x, y) {
    this.id    = Math.random().toString(36).slice(2, 9);
    this.name  = generateName();
    this.x     = x;
    this.y     = y;
    this.color = COLORS[colorIdx++ % COLORS.length];

    this.age    = Math.floor(Math.random() * 20);
    this.hunger = Math.random() * 35;
    this.energy = 55 + Math.random() * 45;
    this.mood   = 45 + Math.random() * 35;
    this.alive  = true;

    this.personality = {
      boldness:  Math.random(),
      empathy:   Math.random(),
      curiosity: Math.random(),
    };

    this.state  = 'wandering';
    this.target = null;

    this.relationships = new Map();
    this.memory        = [];
    this.starvingTicks = 0;
  }

  remember(msg) {
    this.memory.unshift(msg);
    if (this.memory.length > 5) this.memory.pop();
  }

  getRel(entityId) {
    return this.relationships.get(entityId) ?? { type: 'neutral', strength: 0 };
  }

  setRel(entityId, type, strength) {
    this.relationships.set(entityId, { type, strength: clamp(strength, 0, 1) });
  }

  distanceTo(other) {
    return Math.abs(this.x - other.x) + Math.abs(this.y - other.y);
  }

  get displayChar() { return this.name[0]; }

  get stateLabel() {
    return ({
      wandering:    'wandering',
      seeking_food: 'hungry',
      eating:       'eating',
      sleeping:     'sleeping',
      socializing:  'socializing',
      fleeing:      'fleeing',
      fighting:     'fighting',
    })[this.state] ?? this.state;
  }

  get moodLabel() {
    if (this.mood > 75) return 'content';
    if (this.mood > 50) return 'neutral';
    if (this.mood > 25) return 'troubled';
    return 'despair';
  }

  get personalityLabel() {
    const t = [];
    if (this.personality.boldness  > 0.7) t.push('bold');
    else if (this.personality.boldness  < 0.3) t.push('timid');
    if (this.personality.empathy   > 0.7) t.push('warm');
    else if (this.personality.empathy   < 0.3) t.push('cold');
    if (this.personality.curiosity > 0.7) t.push('curious');
    else if (this.personality.curiosity < 0.3) t.push('cautious');
    return t.length ? t.join(', ') : 'unremarkable';
  }

  get dramaticScore() {
    let s = 0;
    if (this.hunger  > 85) s += 35;
    if (this.hunger  > 70) s += 15;
    if (this.energy  < 10) s += 20;
    if (this.mood    < 20) s += 15;
    if (this.age     > 110) s += 20;
    if (this.starvingTicks > 1) s += 25;
    for (const [, r] of this.relationships) {
      if (r.type === 'rival') s += 10;
      if (r.type === 'bond'  && r.strength > 0.9) s += 5;
    }
    return s;
  }

  // ── tick ─────────────────────────────────────────────────
  tick(world) {
    if (!this.alive) return null;

    this.age = +(this.age + 0.04).toFixed(2);

    const hungerRate = this.state === 'eating' ? -5 : 0.55 * world.hungerMult;
    const energyRate = this.state === 'sleeping' ? 3 : -0.18;
    this.hunger = clamp(this.hunger + hungerRate, 0, 100);
    this.energy = clamp(this.energy + energyRate, 0, 100);

    if (this.state === 'socializing') this.mood = clamp(this.mood + 1,    0, 100);
    else if (this.hunger > 75)        this.mood = clamp(this.mood - 0.8,  0, 100);

    this.determineState(world);
    const event = this.executeState(world);

    if (this.hunger >= 100) this.starvingTicks++;
    else this.starvingTicks = 0;

    if (this.starvingTicks >= 5 || this.energy <= 0 || this.age >= 160) {
      this.alive = false;
      const reason = this.starvingTicks >= 5 ? 'starvation'
                   : this.energy <= 0        ? 'exhaustion'
                   :                           'old age';
      this.remember(`died of ${reason}`);
      return { type: 'death', entity: this, reason };
    }

    return event;
  }

  determineState(world) {
    if (this.state === 'fighting') return; // resolved externally

    if (this.hunger > 78) { this.state = 'seeking_food'; return; }
    if (this.energy < 12) { this.state = 'sleeping';     return; }
    if (this.state === 'sleeping' && this.energy < 75)   return;
    if (this.state === 'sleeping') this.state = 'wandering';

    const food = world.nearestFood(this.x, this.y, 4);
    if (food && this.hunger > 35) { this.state = 'seeking_food'; this.target = food; return; }

    const candidates = world.entitiesNear(this, 3)
      .filter(e => this.getRel(e.id).type !== 'rival');
    if (candidates.length && this.hunger < 55 && Math.random() < this.personality.empathy * 0.25) {
      this.state  = 'socializing';
      this.target = candidates[0];
      return;
    }

    this.state = 'wandering';
  }

  executeState(world) {
    switch (this.state) {
      case 'seeking_food': return this.doSeekFood(world);
      case 'eating':       return this.doEat(world);
      case 'sleeping':     return null;
      case 'socializing':  return this.doSocialize(world);
      default:             return this.doWander(world);
    }
  }

  doWander(world) {
    const stormRange = world.activeEvent?.type === 'storm' ? 0 : 0;
    const range = stormRange || (Math.ceil(this.personality.curiosity * 2) + 1);
    this._stepRandom(world, range);
    return null;
  }

  doSeekFood(world) {
    const food = world.nearestFood(this.x, this.y, 25);
    if (!food) { this.doWander(world); return null; }
    if (food.x === this.x && food.y === this.y) { this.state = 'eating'; return null; }
    this._stepToward(world, food.x, food.y);
    return null;
  }

  doEat(world) {
    if (world.consumeFood(this.x, this.y)) {
      if (this.hunger < 20) {
        this.state = 'wandering';
        this.remember('found food and ate well');
        return { type: 'ate', entity: this };
      }
    } else {
      this.state = 'seeking_food';
    }
    return null;
  }

  doSocialize(world) {
    const target = this.target;
    if (!target || !target.alive) { this.state = 'wandering'; this.target = null; return null; }
    if (this.distanceTo(target) > 1) { this._stepToward(world, target.x, target.y); return null; }

    const rel  = this.getRel(target.id);
    const next = clamp(rel.strength + 0.12, 0, 1);
    this.setRel(target.id, 'bond', next);
    target.setRel(this.id, 'bond', next);

    let event = null;
    if (next > 0.8 && rel.strength <= 0.8) {
      event = { type: 'bond_formed', entities: [this, target] };
      this.remember(`formed a deep bond with ${target.name}`);
      target.remember(`formed a deep bond with ${this.name}`);
    }
    this.state = 'wandering'; this.target = null;
    return event;
  }

  _stepRandom(world, range) {
    if (range === 0) return;
    const dx = Math.floor(Math.random() * (range * 2 + 1)) - range;
    const dy = Math.floor(Math.random() * (range * 2 + 1)) - range;
    this._tryMove(world, this.x + dx, this.y + dy);
  }

  _stepToward(world, tx, ty) {
    const dx = Math.sign(tx - this.x);
    const dy = Math.sign(ty - this.y);
    const jitter = Math.random() < 0.2;
    const nx = this.x + (jitter ? (Math.random() < 0.5 ? dx : 0) : dx);
    const ny = this.y + (jitter ? (Math.random() < 0.5 ? dy : 0) : dy);
    this._tryMove(world, nx, ny);
  }

  _tryMove(world, nx, ny) {
    nx = clamp(nx, 0, WORLD_WIDTH  - 1);
    ny = clamp(ny, 0, WORLD_HEIGHT - 1);
    if (world.terrainAt(nx, ny) !== TERRAIN.WATER && world.terrainAt(nx, ny) !== TERRAIN.MOUNTAIN) {
      this.x = nx; this.y = ny;
    }
  }
}
