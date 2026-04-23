import { readFileSync, writeFileSync, existsSync } from 'fs';
import {
  WORLD_WIDTH, WORLD_HEIGHT, TERRAIN, FOOD_NODES,
  INITIAL_ENTITIES, MAX_ENTITIES, SEASON_LENGTH, SEASONS,
  SAVE_INTERVAL, WORLD_EVENT_CHANCE,
} from './config.mjs';
import { Entity } from './entity.mjs';
import { generateWorldName } from './names.mjs';

const SAVE_PATH = './world.json';

// ── Season modifiers ─────────────────────────────────────────
const SEASON_HUNGER = { spring: 0.75, summer: 1.0, autumn: 1.25, winter: 1.65 };
const SEASON_BIRTH  = { spring: 4,    summer: 1,   autumn: 0.4,  winter: 0    };

// ── World events ─────────────────────────────────────────────
const EVENT_POOL = ['drought', 'windfall', 'storm', 'plague'];
const EVENT_DURATION = { drought: 15, windfall: 8, storm: 6, plague: 10 }; // in days

export class World {
  constructor(name = null) {
    this.name   = name ?? generateWorldName();
    this.day    = 0;
    this.tick   = 0;
    this.time   = 'dawn';
    this.paused = false;

    // Stats
    this.totalDeaths = 0;
    this.totalBonds  = 0;
    this.totalBorn   = INITIAL_ENTITIES;
    this.oldestEver  = null; // { name, age }

    // Active world event
    this.activeEvent = null; // { type, endsDay }

    this.terrain   = this._generateTerrain();
    this.foodNodes = new Map();
    this.entities  = [];

    this._placeFoodNodes();
    this._spawnInitial();
  }

  // ── Computed props ────────────────────────────────────────
  get season() {
    return SEASONS[Math.floor(this.day / SEASON_LENGTH) % 4];
  }

  get hungerMult() {
    let m = SEASON_HUNGER[this.season] ?? 1;
    if (this.activeEvent?.type === 'plague')  m *= 1.8;
    if (this.activeEvent?.type === 'drought') m *= 1.3;
    return m;
  }

  get birthMult() {
    if (this.activeEvent?.type === 'plague') return 0;
    return SEASON_BIRTH[this.season] ?? 1;
  }

  // ── Terrain ───────────────────────────────────────────────
  _generateTerrain() {
    const grid = Array.from({ length: WORLD_HEIGHT }, () =>
      Array(WORLD_WIDTH).fill(TERRAIN.PLAINS)
    );
    for (let w = 0; w < 3; w++) {
      let x = Math.floor(Math.random() * WORLD_WIDTH);
      let y = Math.floor(Math.random() * WORLD_HEIGHT);
      const len = 10 + Math.floor(Math.random() * 18);
      for (let i = 0; i < len; i++) {
        x = Math.max(1, Math.min(WORLD_WIDTH - 2,  x + Math.floor(Math.random() * 3) - 1));
        y = Math.max(1, Math.min(WORLD_HEIGHT - 2, y + Math.floor(Math.random() * 3) - 1));
        grid[y][x] = TERRAIN.WATER;
        if (Math.random() < 0.45 && y + 1 < WORLD_HEIGHT) grid[y+1][x] = TERRAIN.WATER;
        if (Math.random() < 0.45 && x + 1 < WORLD_WIDTH)  grid[y][x+1] = TERRAIN.WATER;
      }
    }
    for (let m = 0; m < 2; m++) {
      let x = Math.floor(Math.random() * WORLD_WIDTH);
      let y = Math.floor(Math.random() * WORLD_HEIGHT);
      for (let i = 0; i < 7; i++) {
        x = Math.max(0, Math.min(WORLD_WIDTH-1,  x + Math.floor(Math.random() * 3) - 1));
        y = Math.max(0, Math.min(WORLD_HEIGHT-1, y + Math.floor(Math.random() * 3) - 1));
        if (grid[y][x] === TERRAIN.PLAINS) grid[y][x] = TERRAIN.MOUNTAIN;
      }
    }
    for (let f = 0; f < 5; f++) {
      let x = Math.floor(Math.random() * WORLD_WIDTH);
      let y = Math.floor(Math.random() * WORLD_HEIGHT);
      for (let i = 0; i < 14; i++) {
        x = Math.max(0, Math.min(WORLD_WIDTH-1,  x + Math.floor(Math.random() * 3) - 1));
        y = Math.max(0, Math.min(WORLD_HEIGHT-1, y + Math.floor(Math.random() * 3) - 1));
        if (grid[y][x] === TERRAIN.PLAINS) grid[y][x] = TERRAIN.FOREST;
      }
    }
    return grid;
  }

  _placeFoodNodes(count = FOOD_NODES) {
    let placed = 0, attempts = 0;
    while (placed < count && attempts < 3000) {
      attempts++;
      const x = Math.floor(Math.random() * WORLD_WIDTH);
      const y = Math.floor(Math.random() * WORLD_HEIGHT);
      const t = this.terrain[y]?.[x];
      if (t === TERRAIN.PLAINS || t === TERRAIN.FOREST) {
        const key = `${x},${y}`;
        if (!this.foodNodes.has(key)) {
          this.foodNodes.set(key, { x, y, amount: 5 + Math.floor(Math.random() * 6) });
          placed++;
        }
      }
    }
  }

  _spawnInitial() {
    for (let i = 0; i < INITIAL_ENTITIES; i++) {
      let x, y, a = 0;
      do {
        x = Math.floor(Math.random() * WORLD_WIDTH);
        y = Math.floor(Math.random() * WORLD_HEIGHT);
        a++;
      } while ((this.terrain[y][x] === TERRAIN.WATER || this.terrain[y][x] === TERRAIN.MOUNTAIN) && a < 500);
      this.entities.push(new Entity(x, y));
    }
  }

  // ── Accessors ─────────────────────────────────────────────
  terrainAt(x, y) {
    if (x < 0 || x >= WORLD_WIDTH || y < 0 || y >= WORLD_HEIGHT) return TERRAIN.MOUNTAIN;
    return this.terrain[y][x];
  }

  nearestFood(x, y, maxDist) {
    let best = null, bestDist = Infinity;
    for (const node of this.foodNodes.values()) {
      if (node.amount <= 0) continue;
      const d = Math.abs(node.x - x) + Math.abs(node.y - y);
      if (d <= maxDist && d < bestDist) { best = node; bestDist = d; }
    }
    return best;
  }

  consumeFood(x, y) {
    const key = `${x},${y}`;
    const node = this.foodNodes.get(key);
    if (!node || node.amount <= 0) return false;
    node.amount--;
    if (node.amount <= 0) {
      this.foodNodes.delete(key);
      if (this.activeEvent?.type !== 'drought') {
        const delay = (20000 + Math.random() * 30000) / (this.activeEvent?.type === 'windfall' ? 3 : 1);
        setTimeout(() => {
          const t = this.terrain[y]?.[x];
          if (t === TERRAIN.PLAINS || t === TERRAIN.FOREST) {
            this.foodNodes.set(key, { x, y, amount: 4 + Math.floor(Math.random() * 5) });
          }
        }, delay);
      }
    }
    return true;
  }

  entitiesNear(entity, radius) {
    return this.entities.filter(e =>
      e !== entity && e.alive &&
      Math.abs(e.x - entity.x) <= radius &&
      Math.abs(e.y - entity.y) <= radius
    );
  }

  aliveEntities() { return this.entities.filter(e => e.alive); }

  // ── Stats ─────────────────────────────────────────────────
  get avgMood() {
    const alive = this.aliveEntities();
    if (!alive.length) return 0;
    return alive.reduce((s, e) => s + e.mood, 0) / alive.length;
  }

  get stabilityLabel() {
    const m = this.avgMood;
    if (m > 70) return 'thriving';
    if (m > 50) return 'stable';
    if (m > 30) return 'troubled';
    return 'dire';
  }

  get oldestAlive() {
    const alive = this.aliveEntities();
    if (!alive.length) return null;
    return alive.reduce((o, e) => e.age > (o?.age ?? -1) ? e : o, null);
  }

  // ── Main update ───────────────────────────────────────────
  update() {
    if (this.paused) return [];

    this.tick++;

    // Time of day
    const phase = (this.tick % 200) / 200;
    if      (phase < 0.10) this.time = 'dawn';
    else if (phase < 0.50) this.time = 'day';
    else if (phase < 0.62) this.time = 'dusk';
    else                   this.time = 'night';

    const events = [];

    if (this.tick % 200 === 0) {
      const prevSeason = this.season;
      this.day++;
      if (this.season !== prevSeason) {
        events.push({ type: 'season_change', season: this.season });
      }
    }

    // World event lifecycle
    if (this.activeEvent && this.day >= this.activeEvent.endsDay) {
      events.push({ type: 'event_end', event: this.activeEvent });
      this.activeEvent = null;
      // Windfall: burst of new food
      if (this.activeEvent === null) this._windfall();
    }

    if (!this.activeEvent && Math.random() < WORLD_EVENT_CHANCE) {
      this._triggerWorldEvent(events);
    }

    // Entity ticks
    for (const entity of this.entities) {
      if (!entity.alive) continue;
      const ev = entity.tick(this);
      if (ev) {
        if (ev.type === 'death') {
          this.totalDeaths++;
          if (!this.oldestEver || entity.age > this.oldestEver.age) {
            this.oldestEver = { name: entity.name, age: Math.floor(entity.age) };
          }
        }
        if (ev.type === 'bond_formed') this.totalBonds++;
        events.push(ev);
      }
    }

    // Conflict checks
    this._checkConflicts(events);

    // Birth
    this._tryBirth(events);

    // Auto-save
    if (this.tick % SAVE_INTERVAL === 0) this.save();

    return events;
  }

  // ── Conflict ──────────────────────────────────────────────
  _checkConflicts(events) {
    if (Math.random() > 0.015) return; // low frequency

    const alive = this.aliveEntities();
    for (const a of alive) {
      if (a.personality.boldness < 0.55) continue;
      const adjacent = alive.filter(b => b !== a && a.distanceTo(b) <= 1);

      for (const b of adjacent) {
        const relA = a.getRel(b.id);
        const relB = b.getRel(a.id);
        const bonded = relA.type === 'bond' && relA.strength > 0.6;
        if (bonded) continue;

        // Bold A picks fight with rival or stranger
        if (relA.type === 'rival' || (a.personality.boldness > 0.7 && Math.random() < 0.3)) {
          const scoreA = a.personality.boldness  * (0.5 + Math.random());
          const scoreB = b.personality.boldness  * (0.5 + Math.random());
          const winner = scoreA >= scoreB ? a : b;
          const loser  = winner === a ? b : a;

          winner.energy = Math.max(0, winner.energy - 10);
          winner.mood   = Math.min(100, winner.mood + 20);
          loser.energy  = Math.max(0, loser.energy  - 30);
          loser.mood    = Math.max(0, loser.mood    - 20);
          loser.hunger  = Math.min(100, loser.hunger + 10);

          // Both become rivals unless already bonded
          if (relA.type !== 'bond') { a.setRel(b.id, 'rival', 0.6); b.setRel(a.id, 'rival', 0.6); }

          winner.remember(`prevailed over ${loser.name}`);
          loser.remember(`was beaten by ${winner.name}`);

          events.push({ type: 'conflict', winner, loser });
          return; // one conflict per update
        }
      }
    }
  }

  // ── Birth ─────────────────────────────────────────────────
  _tryBirth(events) {
    if (this.aliveEntities().length >= MAX_ENTITIES) return;
    if (this.birthMult === 0) return;
    if (Math.random() > 0.003 * this.birthMult) return;

    for (const e of this.aliveEntities()) {
      for (const [otherId, rel] of e.relationships) {
        if (rel.type !== 'bond' || rel.strength < 0.75) continue;
        const other = this.entities.find(en => en.id === otherId);
        if (!other?.alive || e.distanceTo(other) > 2) continue;

        let bx = Math.max(0, Math.min(WORLD_WIDTH-1,  e.x + Math.floor(Math.random()*3)-1));
        let by = Math.max(0, Math.min(WORLD_HEIGHT-1, e.y + Math.floor(Math.random()*3)-1));
        if (this.terrain[by][bx] === TERRAIN.WATER || this.terrain[by][bx] === TERRAIN.MOUNTAIN) return;

        const newborn = new Entity(bx, by);
        newborn.age = 0; newborn.hunger = 15; newborn.energy = 100;
        this.entities.push(newborn);
        this.totalBorn++;
        events.push({ type: 'birth', entity: newborn, parent: e });
        return;
      }
    }
  }

  // ── World events ──────────────────────────────────────────
  _triggerWorldEvent(events) {
    const type     = EVENT_POOL[Math.floor(Math.random() * EVENT_POOL.length)];
    const duration = EVENT_DURATION[type] ?? 10;
    this.activeEvent = { type, endsDay: this.day + duration };

    if (type === 'drought') {
      // Remove half the food nodes
      const keys = [...this.foodNodes.keys()];
      for (let i = 0; i < Math.floor(keys.length / 2); i++) {
        this.foodNodes.delete(keys[i]);
      }
    }
    if (type === 'windfall') {
      this._placeFoodNodes(8);
    }

    events.push({ type: 'world_event_start', event: this.activeEvent });
  }

  _windfall() {
    this._placeFoodNodes(6);
  }

  // ── Narrative support ─────────────────────────────────────
  getMostDramatic() {
    const alive = this.aliveEntities();
    if (!alive.length) return null;
    return alive.reduce((b, e) => e.dramaticScore > (b?.dramaticScore ?? -1) ? e : b, null);
  }

  getStateSnapshot(entity) {
    const nearby = this.entitiesNear(entity, 6).map(e => {
      const r = entity.getRel(e.id);
      return `${e.name} (${r.type}, d=${entity.distanceTo(e)})`;
    });
    const bonds = [...entity.relationships.entries()]
      .filter(([, r]) => r.type === 'bond' && r.strength > 0.5)
      .map(([id, r]) => {
        const e = this.entities.find(en => en.id === id);
        return e ? `${e.name} (${(r.strength*100).toFixed(0)}%)` : null;
      }).filter(Boolean);

    return {
      worldName: this.name, worldDay: this.day, worldTime: this.time, worldSeason: this.season,
      name: entity.name, age: Math.floor(entity.age), state: entity.stateLabel,
      hunger: Math.floor(entity.hunger), energy: Math.floor(entity.energy),
      mood: entity.moodLabel, personality: entity.personalityLabel,
      nearby: nearby.join(', ') || 'none',
      bonds:  bonds.join(', ')  || 'none',
      memory: entity.memory.slice(0, 3).join('; ') || 'nothing notable',
    };
  }

  // ── Persistence ───────────────────────────────────────────
  save() {
    const data = {
      v:           2,
      name:        this.name,
      day:         this.day,
      tick:        this.tick,
      totalDeaths: this.totalDeaths,
      totalBonds:  this.totalBonds,
      totalBorn:   this.totalBorn,
      oldestEver:  this.oldestEver,
      activeEvent: this.activeEvent,
      terrain:     this.terrain.map(r => r.join('')).join('|'),
      foodNodes:   [...this.foodNodes.entries()].map(([k, v]) => ({ k, ...v })),
      entities:    this.entities.map(e => ({
        id: e.id, name: e.name, x: e.x, y: e.y, color: e.color,
        age: e.age, hunger: e.hunger, energy: e.energy, mood: e.mood,
        alive: e.alive, personality: e.personality,
        relationships: [...e.relationships.entries()],
        memory: e.memory, starvingTicks: e.starvingTicks,
      })),
    };
    writeFileSync(SAVE_PATH, JSON.stringify(data));
  }

  static load() {
    if (!existsSync(SAVE_PATH)) return null;
    try {
      const data = JSON.parse(readFileSync(SAVE_PATH, 'utf8'));
      if (!data.v || data.v < 2) return null; // incompatible old save

      const w = new World(data.name);
      w.day         = data.day;
      w.tick        = data.tick;
      w.totalDeaths = data.totalDeaths ?? 0;
      w.totalBonds  = data.totalBonds  ?? 0;
      w.totalBorn   = data.totalBorn   ?? INITIAL_ENTITIES;
      w.oldestEver  = data.oldestEver  ?? null;
      w.activeEvent = data.activeEvent ?? null;

      w.terrain = data.terrain.split('|').map(row => row.split(''));
      w.foodNodes = new Map(data.foodNodes.map(n => [n.k, { x: n.x, y: n.y, amount: n.amount }]));

      w.entities = data.entities.map(d => {
        const e = new Entity(d.x, d.y);
        Object.assign(e, {
          id: d.id, name: d.name, color: d.color,
          age: d.age, hunger: d.hunger, energy: d.energy,
          mood: d.mood, alive: d.alive, personality: d.personality,
          memory: d.memory, starvingTicks: d.starvingTicks ?? 0,
        });
        e.relationships = new Map(d.relationships ?? []);
        return e;
      });

      return w;
    } catch {
      return null;
    }
  }

  static hasSave() { return existsSync(SAVE_PATH); }
}
