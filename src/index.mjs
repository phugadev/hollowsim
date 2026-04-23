import 'dotenv/config';
import readline from 'readline';
import { World } from './world.mjs';
import { UI }    from './ui.mjs';
import {
  narrateDramatic, observeEntity, narrateEulogy,
  narrateConflict, narrateWorldEvent, narrateBond,
  shouldNarrate, dramaticEventLabel,
  setModel, getModel,
} from './narrator.mjs';
import { TICK_MS } from './config.mjs';

// ── First-run world name prompt ───────────────────────────────
async function promptWorldName() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('\n  No world found. Name your world: ');
    rl.once('line', answer => { rl.close(); resolve(answer.trim() || 'Unnamed'); });
  });
}

// ── Boot ──────────────────────────────────────────────────────
let world    = World.load();
let isNewWorld = false;

if (!world) {
  isNewWorld = true;
  const name = await promptWorldName();
  world = new World(name);
  world.save();
}

const ui = new UI();

let narratingNow  = false;
let speedMult     = 1;
let tickDelay     = TICK_MS;

// ── Narrator queue ────────────────────────────────────────────
// Each item: { gen: AsyncGenerator, prefix: string, color?: string }
const narratorQueue = [];

function enqueue(gen, prefix = '', color = 'magenta') {
  narratorQueue.push({ gen, prefix, color });
}

async function triggerNarrative(gen, prefix) {
  if (narratingNow) return;
  narratingNow = true;
  ui.openNarrativeLine(prefix);
  try {
    for await (const chunk of gen) ui.appendNarrative(chunk);
    ui.addLog('', 'white');
  } catch (err) {
    ui.addLog(`Narration: ${err.message.slice(0, 70)}`, 'red');
  } finally {
    narratingNow = false;
  }
}

function drainQueue() {
  if (narratingNow || narratorQueue.length === 0) return;
  const { gen, prefix } = narratorQueue.shift();
  triggerNarrative(gen, prefix);
}

// ── Event processing ──────────────────────────────────────────
function processEvents(events) {
  for (const ev of events) {
    switch (ev.type) {

      case 'death':
        // Plain log immediately; eulogy queued
        ui.addLog(`${ev.entity.name} dies — ${ev.reason}.`, 'red');
        enqueue(narrateEulogy(world, ev.entity, ev.reason), `${ev.entity.name} — `);
        setTimeout(() => { world.entities = world.entities.filter(e => e !== ev.entity); }, 5000);
        break;

      case 'birth':
        ui.addLog(`${ev.entity.name} enters ${world.name}, born of ${ev.parent.name}.`, 'green');
        break;

      case 'bond_formed': {
        const [a, b] = ev.entities;
        ui.addLog(`${a.name} and ${b.name} have formed a bond.`, 'cyan');
        // Only narrate deep bonds (not every small one — too noisy)
        if (Math.random() < 0.5) enqueue(narrateBond(world, a, b), '');
        break;
      }

      case 'conflict':
        enqueue(narrateConflict(world, ev.winner, ev.loser), '');
        break;

      case 'season_change': {
        const labels = { spring: 'Spring stirs.', summer: 'Summer settles in.', autumn: 'Autumn descends.', winter: 'Winter arrives.' };
        const colors = { spring: 'green', summer: 'white', autumn: 'yellow', winter: 'cyan' };
        ui.addLog(labels[ev.season] ?? `Season: ${ev.season}`, colors[ev.season] ?? 'white');
        break;
      }

      case 'world_event_start':
        enqueue(narrateWorldEvent(world, ev.event.type), '');
        break;

      case 'event_end':
        ui.addLog(`The ${ev.event.type} has passed.`, 'white');
        break;

      case 'ate':
        if (Math.random() < 0.04) ui.addLog(`${ev.entity.name} finds sustenance.`, 'white');
        break;
    }
  }
}

// ── Inspect / observe helpers ─────────────────────────────────
function doObserve(entity) {
  if (!entity) return;
  enqueue(observeEntity(world, entity), `${entity.name} — `);
}

function doInspect(entity) {
  const e   = entity;
  const div = '─'.repeat(32);
  ui.addLog(div, 'white');
  ui.addLog(`${e.name}  ·  age ${Math.floor(e.age)}  ·  ${e.personalityLabel}`, 'cyan');
  ui.addLog(`state: ${e.stateLabel}  mood: ${e.moodLabel}  drama: ${e.dramaticScore}`, 'white');
  ui.addLog(`hunger: ${Math.floor(e.hunger)}/100   energy: ${Math.floor(e.energy)}/100`, 'white');

  const rels = [...e.relationships.entries()];
  if (rels.length) {
    ui.addLog('relationships:', 'white');
    for (const [id, r] of rels) {
      const other = world.entities.find(en => en.id === id);
      const oname = other ? other.name + (other.alive ? '' : ' (dead)') : id;
      ui.addLog(`  ${oname} — ${r.type} ${(r.strength * 100).toFixed(0)}%`, 'white');
    }
  } else {
    ui.addLog('relationships: none', 'white');
  }

  ui.addLog('memory:', 'white');
  if (e.memory.length) for (const m of e.memory) ui.addLog(`  · ${m}`, 'white');
  else ui.addLog('  · nothing notable', 'white');
  ui.addLog(div, 'white');
}

// ── Commands ──────────────────────────────────────────────────
ui.onCommand(async cmd => {
  const norm  = cmd.replace(/^\//, '').trim();
  const lower = norm.toLowerCase();

  if (lower === 'quit' || lower === 'q') { ui.screen.destroy(); process.exit(0); }

  if (lower === 'pause') {
    world.paused = true;
    ui.addLog('Time has stilled.', 'yellow');
    ui.updateTitle(world, speedMult); ui.render(); return;
  }
  if (lower === 'resume' || lower === 'unpause') {
    world.paused = false;
    ui.addLog('Time resumes.', 'yellow'); return;
  }

  if (lower.startsWith('speed')) {
    const mult = parseFloat(lower.split(/\s+/)[1]);
    if (!mult || mult <= 0 || mult > 10) {
      ui.addLog('Usage: speed <0.25–10>  e.g. speed 2, speed 0.5', 'yellow'); return;
    }
    speedMult = mult;
    tickDelay = Math.round(TICK_MS / mult);
    ui.addLog(`Speed ×${mult} (${tickDelay}ms/tick).`, 'yellow');
    ui.updateTitle(world, speedMult); ui.render(); return;
  }

  if (lower.startsWith('model')) {
    const parts = lower.split(/\s+/);
    if (parts.length < 2) {
      ui.addLog(`Active model: ${getModel()}. Usage: model <name>  e.g. model gemma4`, 'yellow'); return;
    }
    setModel(parts[1]);
    ui.addLog(`Model switched to ${getModel()}.`, 'yellow'); return;
  }

  if (lower === 'save') { world.save(); ui.addLog('World saved.', 'yellow'); return; }

  if (lower === 'help') {
    ui.addLog('observe <name>    — narrate a soul\'s inner state', 'white');
    ui.addLog('inspect <name>    — full dossier: stats, memory, relationships', 'white');
    ui.addLog('souls             — list all living souls', 'white');
    ui.addLog('pause / resume    — freeze / unfreeze time', 'white');
    ui.addLog('speed <n>         — set speed multiplier (e.g. speed 2)', 'white');
    ui.addLog(`model <name>      — swap Ollama model (active: ${getModel()})`, 'white');
    ui.addLog('save              — save world now', 'white');
    ui.addLog('click map         — observe that soul instantly', 'white');
    ui.addLog('q                 — quit', 'white');
    return;
  }

  if (lower === 'souls' || lower === 'list') {
    const alive = world.aliveEntities();
    ui.addLog(`Living souls (${alive.length}):`, 'white');
    for (const e of alive)
      ui.addLog(`  ${e.name} — ${e.personalityLabel} — age ${Math.floor(e.age)} — ${e.stateLabel}`, 'white');
    return;
  }

  if (lower.startsWith('observe ')) {
    const q = norm.slice(8).trim().toLowerCase();
    const e = world.aliveEntities().find(en => en.name.toLowerCase().startsWith(q));
    if (!e) { ui.addLog(`No soul named "${q}" found.`, 'red'); return; }
    doObserve(e); return;
  }

  if (lower.startsWith('inspect ')) {
    const q = norm.slice(8).trim().toLowerCase();
    const e = world.entities.find(en => en.name.toLowerCase().startsWith(q));
    if (!e) { ui.addLog(`No soul named "${q}" found.`, 'red'); return; }
    doInspect(e); return;
  }

  ui.addLog(`Unknown command: "${norm}". Type help.`, 'red');
});

// ── Mouse ─────────────────────────────────────────────────────
ui.onMapClick((wx, wy) => {
  const e = world.aliveEntities().find(en => en.x === wx && en.y === wy);
  if (e) doObserve(e);
});

// ── Tick ──────────────────────────────────────────────────────
function tick() {
  const events = world.update();
  processEvents(events);

  // Drain narrator queue first; fall back to auto-dramatic narration
  if (!narratingNow) {
    if (narratorQueue.length > 0) {
      drainQueue();
    } else {
      const dramatic = world.getMostDramatic();
      if (dramatic && shouldNarrate(dramatic)) {
        triggerNarrative(narrateDramatic(world, dramatic, dramaticEventLabel(dramatic)), '');
      }
    }
  }

  ui.renderWorld(world);
  ui.renderEntities(world);
  ui.renderStats(world);
  ui.updateTitle(world, speedMult);
  ui.render();

  setTimeout(tick, tickDelay);
}

// ── Splash ────────────────────────────────────────────────────
if (isNewWorld) {
  ui.addLog(`${world.name} is born.`, 'cyan');
  ui.addLog(`${world.aliveEntities().length} souls breathe in the ${world.time}.`, 'white');
} else {
  ui.addLog(`Returning to ${world.name} — Day ${world.day}, ${world.season}.`, 'cyan');
  ui.addLog(`${world.aliveEntities().length} souls remain.`, 'white');
}
ui.addLog('', 'white');
ui.addLog(`Model: ${getModel()} · Press : or / for commands · Click a soul to observe`, 'white');
ui.addLog('', 'white');

ui.renderWorld(world);
ui.renderEntities(world);
ui.renderStats(world);
ui.updateTitle(world, speedMult);
ui.render();

setTimeout(tick, tickDelay);
