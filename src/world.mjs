import { readFileSync, writeFileSync, existsSync } from 'fs';
import {
  WORLD_WIDTH, WORLD_HEIGHT, TERRAIN, FOOD_NODES,
  INITIAL_ENTITIES, MAX_ENTITIES, SEASON_LENGTH, SEASONS,
  SAVE_INTERVAL, WORLD_EVENT_CHANCE,
} from './config.mjs';
import { Entity } from './entity.mjs';
import { generateWorldName, generateFactionName } from './names.mjs';

const SAVE_PATH = './world.json';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Season modifiers ─────────────────────────────────────────
const SEASON_HUNGER = { spring: 0.75, summer: 1.0, autumn: 1.25, winter: 1.65 };
const SEASON_BIRTH  = { spring: 4,    summer: 1,   autumn: 0.4,  winter: 0    };

// ── World events ─────────────────────────────────────────────
const EVENT_POOL = ['drought', 'windfall', 'storm', 'plague'];
const EVENT_DURATION = { drought: 15, windfall: 8, storm: 6, plague: 10 }; // in days

// ── Ambitions ─────────────────────────────────────────────────
const AMBITIONS = ['bond', 'elder', 'explore', 'parent', 'ruins'];
export const AMBITION_DESC = {
  bond:    'forge a bond that endures',
  elder:   'live to see old age',
  explore: 'find wonder five times',
  parent:  'bring new life into the world',
  ruins:   'stand where the ancients stood',
};
function randomAmbition() { return AMBITIONS[Math.floor(Math.random() * AMBITIONS.length)]; }

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

    // Chronicle — last 40 significant events, persisted
    this.history = [];

    // Factions — named social clusters
    this.factions = new Map(); // id → { id, name, memberIds: Set<string>, foundedDay }

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
    const W = WORLD_WIDTH, H = WORLD_HEIGHT;

    // ── Height field: weighted sum of gaussian "feature peaks" ──
    // More features = more varied, overlapping = smooth blends
    const nFeatures = 28;
    const features = Array.from({ length: nFeatures }, () => ({
      x:     Math.random() * W,
      y:     Math.random() * H,
      value: Math.random(),                  // 0 = basin, 1 = peak
      r:     8 + Math.random() * (W * 0.22), // influence radius
    }));

    const hf = Array.from({ length: H }, (_, y) =>
      Array.from({ length: W }, (__, x) => {
        let sum = 0, wt = 0;
        for (const f of features) {
          const d = Math.hypot(x - f.x, y - f.y);
          const w = Math.max(0, 1 - d / f.r);
          sum += f.value * w; wt += w;
        }
        return wt > 0 ? sum / wt : 0.5;
      })
    );

    // Normalise to [0, 1]
    let lo = Infinity, hi = -Infinity;
    for (const row of hf) for (const v of row) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const span = hi - lo || 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) hf[y][x] = (hf[y][x] - lo) / span;

    // ── Primary terrain from height thresholds ───────────────
    // Low = water, high = mountain, slopes = forest, middle = plains
    const grid = hf.map(row => row.map(h =>
      h < 0.22  ? TERRAIN.WATER    :
      h > 0.82  ? TERRAIN.MOUNTAIN :
      h < 0.38  ? TERRAIN.FOREST   :   // dense lowland forest hugging water
      TERRAIN.PLAINS
    ));

    // ── Inland forest patches (mid-slope scatter) ────────────
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (grid[y][x] === TERRAIN.PLAINS && hf[y][x] > 0.52 && hf[y][x] < 0.70) {
          if (Math.random() < 0.14) grid[y][x] = TERRAIN.FOREST;
        }
      }
    }

    // ── Mountain foothills: sparse forest on lower slopes ────
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (grid[y][x] === TERRAIN.PLAINS && hf[y][x] > 0.72 && hf[y][x] < 0.82) {
          if (Math.random() < 0.25) grid[y][x] = TERRAIN.FOREST;
        }
      }
    }

    // ── Rivers: trace downhill paths from mountain edges ─────
    const nRivers = 2 + Math.floor(Math.random() * 3);
    for (let r = 0; r < nRivers; r++) {
      // Find a mountain-adjacent plains/forest cell as river head
      const starts = [];
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          if (grid[y][x] !== TERRAIN.MOUNTAIN && hf[y][x] > 0.60) {
            const nbrs = [[y-1,x],[y+1,x],[y,x-1],[y,x+1]];
            if (nbrs.some(([ny, nx]) => grid[ny]?.[nx] === TERRAIN.MOUNTAIN)) {
              starts.push({ x, y });
            }
          }
        }
      }
      if (!starts.length) continue;
      let { x, y } = starts[Math.floor(Math.random() * starts.length)];
      for (let step = 0; step < 60; step++) {
        if (x < 0 || x >= W || y < 0 || y >= H) break;
        if (grid[y][x] === TERRAIN.WATER) break; // reached a lake
        grid[y][x] = TERRAIN.WATER;
        // Step toward lowest neighbour with slight random drift
        const candidates = [
          { nx: x,   ny: y+1 }, { nx: x,   ny: y-1 },
          { nx: x+1, ny: y   }, { nx: x-1, ny: y   },
        ].filter(c => c.nx >= 0 && c.nx < W && c.ny >= 0 && c.ny < H);
        candidates.sort((a, b) => hf[a.ny]?.[a.nx] - hf[b.ny]?.[b.nx]);
        // Pick lowest or occasionally second-lowest (organic bends)
        const pick = Math.random() < 0.75 ? candidates[0] : (candidates[1] ?? candidates[0]);
        x = pick.nx; y = pick.ny;
      }
    }

    // ── Ruins — rare ancient sites on plains only ────────────
    const nRuins = 4 + Math.floor(Math.random() * 4);
    let ruinsPlaced = 0, att = 0;
    while (ruinsPlaced < nRuins && att < 3000) {
      att++;
      const x = 3 + Math.floor(Math.random() * (W - 6));
      const y = 3 + Math.floor(Math.random() * (H - 6));
      if (grid[y][x] === TERRAIN.PLAINS) {
        grid[y][x] = TERRAIN.RUINS;
        ruinsPlaced++;
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
      if (t === TERRAIN.PLAINS || t === TERRAIN.FOREST || t === TERRAIN.RUINS) {
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
      const e = new Entity(x, y);
      e.ambition = randomAmbition();
      this.entities.push(e);
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
          if (t === TERRAIN.PLAINS || t === TERRAIN.FOREST || t === TERRAIN.RUINS) {
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

    // Wanderer arrivals
    this._tryArrival(events);

    // Faction updates (every 50 ticks)
    if (this.tick % 50 === 0) this._updateFactions(events);

    // Ambition checks + elder wisdom aura
    for (const entity of this.aliveEntities()) {
      if (!entity.ambitionFulfilled && entity.ambition && this._checkAmbition(entity)) {
        entity.ambitionFulfilled = true;
        entity.fulfillment = clamp(entity.fulfillment + 30, 0, 100);
        entity.mood        = clamp(entity.mood + 15, 0, 100);
        entity.remember(`fulfilled: ${AMBITION_DESC[entity.ambition]}`);
        events.push({ type: 'ambition_fulfilled', entity });
      }
      if (entity.lifeStage === 'elder' && Math.random() < 0.25) {
        for (const other of this.entitiesNear(entity, 3)) {
          other.mood = clamp(other.mood + 0.4, 0, 100);
        }
      }
    }

    // Grudge evolution — rivalries deepen when near, cool when apart
    if (this.tick % 10 === 0) {
      for (const entity of this.aliveEntities()) {
        for (const [otherId, rel] of entity.relationships) {
          if (rel.type !== 'rival') continue;
          const other = this.entities.find(e => e.id === otherId && e.alive);
          const near  = other && entity.distanceTo(other) <= 3;
          const delta = near ? +0.006 : -0.002;
          const next  = Math.max(0, Math.min(1, rel.strength + delta));
          if (next === 0) {
            entity.relationships.delete(otherId); // grudge fades to indifference
          } else {
            entity.relationships.set(otherId, { type: 'rival', strength: next });
          }
        }
      }
    }

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

        // Bold A picks fight, or old grudge boils over (strength > 0.85 triggers even timid souls)
        const deepGrudge = relA.type === 'rival' && relA.strength > 0.85;
        if (deepGrudge || relA.type === 'rival' || (a.personality.boldness > 0.7 && Math.random() < 0.3)) {
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

          const winnerFaction = this.getFactionOf(winner);
          const loserFaction  = this.getFactionOf(loser);
          const interFaction  = winnerFaction && loserFaction && winnerFaction.id !== loserFaction.id;
          events.push({ type: 'conflict', winner, loser, winnerFaction, loserFaction, interFaction });
          return; // one conflict per update
        }
      }
    }
  }

  // ── Factions ──────────────────────────────────────────────
  getFactionOf(entity) {
    if (!entity.factionId) return null;
    return this.factions.get(entity.factionId) ?? null;
  }

  _updateFactions(events) {
    const alive = this.aliveEntities();

    // Build bond adjacency (mutual bond > 0.5 both ways)
    const adj = new Map();
    for (const e of alive) {
      for (const [otherId, rel] of e.relationships) {
        if (rel.type !== 'bond' || rel.strength < 0.5) continue;
        const other = this.entities.find(x => x.id === otherId && x.alive);
        if (!other) continue;
        const back = other.getRel(e.id);
        if (back.type !== 'bond' || back.strength < 0.5) continue;
        if (!adj.has(e.id)) adj.set(e.id, new Set());
        adj.get(e.id).add(otherId);
      }
    }

    // Connected components
    const visited = new Set();
    const components = []; // Array of Set<entityId>
    for (const e of alive) {
      if (visited.has(e.id)) continue;
      const comp = new Set();
      const stack = [e.id];
      while (stack.length) {
        const id = stack.pop();
        if (visited.has(id)) continue;
        visited.add(id); comp.add(id);
        for (const nid of (adj.get(id) ?? [])) stack.push(nid);
      }
      components.push(comp);
    }

    // For each component of size >= 3: find or create a faction
    const activeFactionIds = new Set();
    for (const comp of components) {
      if (comp.size < 3) continue;

      // Which existing factions have members in this component?
      // Filter to only valid factions — stale factionIds (e.g. from revived souls) must be excluded.
      const existing = new Set(
        [...comp]
          .map(id => this.entities.find(e => e.id === id)?.factionId)
          .filter(fid => fid && this.factions.has(fid))
      );

      let faction;
      if (existing.size === 0) {
        // New faction
        const id = Math.random().toString(36).slice(2, 9);
        faction = { id, name: generateFactionName(), memberIds: new Set(), foundedDay: this.day };
        this.factions.set(id, faction);
        events.push({ type: 'faction_formed', faction });
        this.addHistory(`Day ${this.day}: ${faction.name} formed.`);
      } else {
        // Use largest existing faction; absorb others into it
        let largest = null;
        for (const fid of existing) {
          const f = this.factions.get(fid);
          if (!largest || f.memberIds.size > largest.memberIds.size) largest = f;
        }
        faction = largest;
        for (const fid of existing) {
          if (fid !== faction.id) this.factions.delete(fid); // absorbed
        }
      }

      // Update membership
      faction.memberIds = comp;
      activeFactionIds.add(faction.id);
      for (const id of comp) {
        const e = this.entities.find(x => x.id === id);
        if (e) e.factionId = faction.id;
      }
    }

    // Clear faction from souls not in any active faction
    for (const e of alive) {
      if (e.factionId && !activeFactionIds.has(e.factionId)) {
        e.factionId = null;
      }
    }

    // Remove factions with no living members
    for (const [fid, faction] of this.factions) {
      const living = [...faction.memberIds].filter(id => alive.some(e => e.id === id));
      if (living.length === 0) {
        this.factions.delete(fid);
      } else if (living.length < 3) {
        // Dissolved — not enough members
        for (const id of living) {
          const e = this.entities.find(x => x.id === id);
          if (e) e.factionId = null;
        }
        events.push({ type: 'faction_dissolved', faction });
        this.factions.delete(fid);
      }
    }
  }

  // Tension between two factions: sum of rival strengths across member pairs
  factionTension(fA, fB) {
    let t = 0;
    for (const aid of fA.memberIds) {
      const a = this.entities.find(e => e.id === aid && e.alive);
      if (!a) continue;
      for (const bid of fB.memberIds) {
        const r = a.getRel(bid);
        if (r.type === 'rival') t += r.strength;
      }
    }
    return t;
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
        newborn.age     = 0; newborn.hunger = 15; newborn.energy = 100;
        newborn.parents = [e.id, otherId];

        // Inherit blended personality with mutation
        const p1 = e.personality, p2 = other.personality;
        const mutate = v => clamp(v + (Math.random() * 0.24 - 0.12), 0, 1);
        newborn.personality = {
          boldness:  mutate((p1.boldness  + p2.boldness)  / 2),
          empathy:   mutate((p1.empathy   + p2.empathy)   / 2),
          curiosity: mutate((p1.curiosity + p2.curiosity) / 2),
        };

        newborn.ambition = randomAmbition();
        this.entities.push(newborn);
        this.totalBorn++;
        events.push({ type: 'birth', entity: newborn, parent: e });
        return;
      }
    }
  }

  // ── Wanderer arrivals ─────────────────────────────────────
  _tryArrival(events) {
    const alive = this.aliveEntities().length;
    if (alive >= MAX_ENTITIES) return;

    // Chance scales with how empty the world is
    // 0 alive → ~2% per tick (~15s avg), 1-2 → 0.8%, 3-4 → 0.2%, 5+ → 0.05%
    const chance = alive === 0 ? 0.02
                 : alive <= 2  ? 0.008
                 : alive <= 4  ? 0.002
                 :               0.0005;

    if (Math.random() > chance) return;

    const tile = this._randomEdgeTile();
    if (!tile) return;

    const wanderer = new Entity(tile.x, tile.y);
    wanderer.age       = Math.floor(Math.random() * 30); // arrives with some history
    wanderer.hunger    = 30 + Math.random() * 30;        // a little hungry from the journey
    wanderer.energy    = 50 + Math.random() * 40;
    wanderer.ambition  = randomAmbition();
    this.entities.push(wanderer);
    this.totalBorn++;

    events.push({ type: 'arrival', entity: wanderer, wasEmpty: alive === 0 });
  }

  _randomEdgeTile() {
    // Collect all walkable edge tiles
    const candidates = [];
    for (let x = 0; x < WORLD_WIDTH; x++) {
      if (this.terrain[0][x] !== TERRAIN.WATER && this.terrain[0][x] !== TERRAIN.MOUNTAIN)
        candidates.push({ x, y: 0 });
      if (this.terrain[WORLD_HEIGHT-1][x] !== TERRAIN.WATER && this.terrain[WORLD_HEIGHT-1][x] !== TERRAIN.MOUNTAIN)
        candidates.push({ x, y: WORLD_HEIGHT - 1 });
    }
    for (let y = 1; y < WORLD_HEIGHT - 1; y++) {
      if (this.terrain[y][0] !== TERRAIN.WATER && this.terrain[y][0] !== TERRAIN.MOUNTAIN)
        candidates.push({ x: 0, y });
      if (this.terrain[y][WORLD_WIDTH-1] !== TERRAIN.WATER && this.terrain[y][WORLD_WIDTH-1] !== TERRAIN.MOUNTAIN)
        candidates.push({ x: WORLD_WIDTH - 1, y });
    }
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
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

  // ── Ambition ──────────────────────────────────────────────
  _checkAmbition(entity) {
    switch (entity.ambition) {
      case 'bond':    return [...entity.relationships.values()].some(r => r.type === 'bond' && r.strength >= 0.88);
      case 'elder':   return entity.age >= 80;
      case 'explore': return entity.discoveryCount >= 5;
      case 'parent':  return this.entities.some(c => c.parents?.includes(entity.id));
      case 'ruins':   return entity.visitedRuins;
      default:        return false;
    }
  }

  // ── Regret ───────────────────────────────────────────────
  findRegret(entity) {
    // Unfulfilled ambition — most personal regret
    if (entity.ambition && !entity.ambitionFulfilled) {
      return `never got to ${AMBITION_DESC[entity.ambition]}`;
    }
    // Unresolved rivalry
    for (const [id, r] of entity.relationships) {
      if (r.type === 'rival' && r.strength > 0.4) {
        const other = this.entities.find(e => e.id === id);
        if (other) return `had an unresolved grudge with ${other.name}`;
      }
    }
    // Bond with a soul who died before them
    for (const [id, r] of entity.relationships) {
      if (r.type === 'bond' && r.strength > 0.6) {
        const other = this.entities.find(e => e.id === id);
        if (other && !other.alive) return `carried grief for ${other.name}, who died first`;
      }
    }
    // Died yearning for more
    if ((entity.fulfillment ?? 50) < 25) return `died before finding what they were looking for`;
    // Died young
    if (entity.age < 25) return `died too young, with much unlived`;
    return null;
  }

  // ── History ───────────────────────────────────────────────
  addHistory(text) {
    this.history.push({ day: this.day, text });
    if (this.history.length > 40) this.history.shift();
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

    const ambitionText = entity.ambition
      ? (entity.ambitionFulfilled
          ? `fulfilled: ${AMBITION_DESC[entity.ambition]}`
          : `seeks to ${AMBITION_DESC[entity.ambition]}`)
      : null;

    const faction = this.getFactionOf(entity);

    return {
      worldName: this.name, worldDay: this.day, worldTime: this.time, worldSeason: this.season,
      name: entity.name, age: Math.floor(entity.age), state: entity.stateLabel,
      lifeStage: entity.lifeStage,
      faction: faction?.name ?? null,
      hunger: Math.floor(entity.hunger), energy: Math.floor(entity.energy),
      fulfillment: Math.floor(entity.fulfillment ?? 50),
      mood: entity.moodLabel, personality: entity.personalityLabel,
      ambition: ambitionText,
      nearby: nearby.join(', ') || 'none',
      bonds:  bonds.join(', ')  || 'none',
      memory: entity.memory.slice(0, 3).join('; ') || 'nothing notable',
    };
  }

  // ── Persistence ───────────────────────────────────────────
  save() {
    const data = {
      v:           4,
      name:        this.name,
      day:         this.day,
      tick:        this.tick,
      totalDeaths: this.totalDeaths,
      totalBonds:  this.totalBonds,
      totalBorn:   this.totalBorn,
      oldestEver:  this.oldestEver,
      activeEvent: this.activeEvent,
      history:     this.history,
      terrain:     this.terrain.map(r => r.join('')).join('|'),
      foodNodes:   [...this.foodNodes.entries()].map(([k, v]) => ({ k, ...v })),
      factions:    [...this.factions.values()].map(f => ({
        id: f.id, name: f.name, foundedDay: f.foundedDay,
        memberIds: [...f.memberIds],
      })),
      entities:    this.entities.map(e => ({
        id: e.id, name: e.name, x: e.x, y: e.y, color: e.color,
        age: e.age, hunger: e.hunger, energy: e.energy, mood: e.mood,
        fulfillment: e.fulfillment ?? 50,
        alive: e.alive, personality: e.personality,
        parents: e.parents ?? [],
        relationships: [...e.relationships.entries()],
        memory: e.memory, heard: e.heard ?? [],
        starvingTicks: e.starvingTicks,
        ambition: e.ambition ?? null,
        ambitionFulfilled: e.ambitionFulfilled ?? false,
        discoveryCount: e.discoveryCount ?? 0,
        visitedRuins: e.visitedRuins ?? false,
        factionId: e.factionId ?? null,
      })),
    };
    writeFileSync(SAVE_PATH, JSON.stringify(data));
  }

  static load() {
    if (!existsSync(SAVE_PATH)) return null;
    try {
      const data = JSON.parse(readFileSync(SAVE_PATH, 'utf8'));
      if (!data.v || data.v < 4) return null; // incompatible — world size / terrain changed

      const w = new World(data.name);
      w.day         = data.day;
      w.tick        = data.tick;
      w.totalDeaths = data.totalDeaths ?? 0;
      w.totalBonds  = data.totalBonds  ?? 0;
      w.totalBorn   = data.totalBorn   ?? INITIAL_ENTITIES;
      w.oldestEver  = data.oldestEver  ?? null;
      w.activeEvent = data.activeEvent ?? null;
      w.history     = data.history     ?? [];

      w.factions = new Map((data.factions ?? []).map(f => [
        f.id,
        { id: f.id, name: f.name, foundedDay: f.foundedDay, memberIds: new Set(f.memberIds) },
      ]));

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
        e.fulfillment       = d.fulfillment ?? 50;
        e.parents           = d.parents ?? [];
        e.heard             = d.heard   ?? [];
        e.relationships     = new Map(d.relationships ?? []);
        e.ambition          = d.ambition          ?? randomAmbition();
        e.ambitionFulfilled = d.ambitionFulfilled  ?? false;
        e.discoveryCount    = d.discoveryCount     ?? 0;
        e.visitedRuins      = d.visitedRuins       ?? false;
        e.factionId         = d.factionId          ?? null;
        return e;
      });

      return w;
    } catch {
      return null;
    }
  }

  static hasSave() { return existsSync(SAVE_PATH); }
}
