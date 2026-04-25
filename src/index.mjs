import 'dotenv/config';
import readline from 'readline';
import { World } from './world.mjs';
import { UI }    from './ui.mjs';
import {
  narrateDramatic, observeEntity, narrateDream, narrateEulogy, narrateRegret,
  narrateConflict, narrateWorldEvent, narrateBond, narrateArrival,
  narrateTalkOpening, narrateTalkReply,
  narrateAsk, narrateIntervention, narrateAmbition, narrateFactionFormed,
  shouldNarrate, dramaticEventLabel,
  setModel, getModel,
} from './narrator.mjs';
import { AMBITION_DESC } from './world.mjs';
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

// ── Talk session ──────────────────────────────────────────────
// { entity, history: [{role, content}] } or null
let talkSession = null;

function talkActive() { return talkSession !== null && talkSession.entity.alive; }

function endTalk() {
  if (!talkSession) return;
  ui.addLog(`─── left ${talkSession.entity.name} ───`, 'yellow');
  talkSession = null;
  ui.updateTitle(world, speedMult, talkSession?.entity?.name ?? null);
  ui.render();
}

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

      case 'death': {
        ui.addLog(`${ev.entity.name} dies — ${ev.reason}.`, 'red');
        ui.addLog(`  revive ${ev.entity.name} within 5 minutes.`, 'yellow');
        world.addHistory(`Day ${world.day}: ${ev.entity.name} died of ${ev.reason}, age ${Math.floor(ev.entity.age)}.`);
        enqueue(narrateEulogy(world, ev.entity, ev.reason), `${ev.entity.name} — `);
        const regret = world.findRegret(ev.entity);
        if (regret) enqueue(narrateRegret(world, ev.entity, regret), `${ev.entity.name} — `);
        // Keep dead soul in array until grace window passes so revive can find them
        setTimeout(() => { world.entities = world.entities.filter(e => e !== ev.entity); }, 310000);
        break;
      }

      case 'birth':
        ui.addLog(`${ev.entity.name} enters ${world.name}, born of ${ev.parent.name}.`, 'green');
        world.addHistory(`Day ${world.day}: ${ev.entity.name} was born of ${ev.parent.name}.`);
        break;

      case 'bond_formed': {
        const [a, b] = ev.entities;
        ui.addLog(`${a.name} and ${b.name} have formed a bond.`, 'cyan');
        world.addHistory(`Day ${world.day}: ${a.name} and ${b.name} formed a deep bond.`);
        // Only narrate deep bonds (not every small one — too noisy)
        if (Math.random() < 0.5) enqueue(narrateBond(world, a, b), '');
        break;
      }

      case 'conflict': {
        const fTag = ev.interFaction
          ? ` [${ev.winnerFaction.name} vs ${ev.loserFaction.name}]`
          : '';
        ui.addLog(`${ev.winner.name} prevailed over ${ev.loser.name}.${fTag}`, ev.interFaction ? 'red' : 'white');
        world.addHistory(`Day ${world.day}: ${ev.winner.name} prevailed over ${ev.loser.name}.${fTag}`);
        enqueue(narrateConflict(world, ev.winner, ev.loser), '');
        break;
      }

      case 'faction_formed': {
        const members = [...ev.faction.memberIds]
          .map(id => world.entities.find(e => e.id === id))
          .filter(Boolean);
        ui.addLog(`${ev.faction.name} has formed (${members.length} souls).`, 'cyan');
        enqueue(narrateFactionFormed(world, ev.faction, members), `${ev.faction.name} — `);
        break;
      }

      case 'faction_dissolved':
        ui.addLog(`${ev.faction.name} has dissolved.`, 'yellow');
        world.addHistory(`Day ${world.day}: ${ev.faction.name} dissolved.`);
        break;

      case 'teaching':
        if (Math.random() < 0.3)
          ui.addLog(`${ev.teacher.name} teaches ${ev.student.name}: "${ev.lesson}".`, 'white');
        break;

      case 'season_change': {
        const labels = { spring: 'Spring stirs.', summer: 'Summer settles in.', autumn: 'Autumn descends.', winter: 'Winter arrives.' };
        const colors = { spring: 'green', summer: 'white', autumn: 'yellow', winter: 'cyan' };
        ui.addLog(labels[ev.season] ?? `Season: ${ev.season}`, colors[ev.season] ?? 'white');
        world.addHistory(`Day ${world.day}: ${ev.season} began.`);
        break;
      }

      case 'world_event_start':
        world.addHistory(`Day ${world.day}: a ${ev.event.type} began.`);
        enqueue(narrateWorldEvent(world, ev.event.type), '');
        break;

      case 'event_end':
        ui.addLog(`The ${ev.event.type} has passed.`, 'white');
        world.addHistory(`Day ${world.day}: the ${ev.event.type} ended.`);
        break;

      case 'arrival': {
        const msg = ev.wasEmpty
          ? `${ev.entity.name} arrives at the edge of ${world.name}. The world breathes again.`
          : `${ev.entity.name} wanders in from beyond the edge.`;
        ui.addLog(msg, 'yellow');
        world.addHistory(`Day ${world.day}: ${ev.entity.name} arrived from beyond the edge.`);
        enqueue(narrateArrival(world, ev.entity, ev.wasEmpty), `${ev.entity.name} — `);
        break;
      }

      case 'discovery':
        ui.addLog(`${ev.entity.name} ${ev.label}.`, 'white');
        break;

      case 'ambition_fulfilled': {
        const desc = AMBITION_DESC[ev.entity.ambition] ?? ev.entity.ambition;
        ui.addLog(`${ev.entity.name} fulfills their ambition — to ${desc}.`, 'cyan');
        enqueue(narrateAmbition(world, ev.entity), `${ev.entity.name} — `);
        world.addHistory(`Day ${world.day}: ${ev.entity.name} fulfilled their ambition — to ${desc}.`);
        break;
      }

      case 'ate':
        if (Math.random() < 0.04) ui.addLog(`${ev.entity.name} finds sustenance.`, 'white');
        break;
    }
  }
}

// ── Inspect / observe helpers ─────────────────────────────────
function doObserve(entity) {
  if (!entity) return;
  if (entity.state === 'sleeping') {
    enqueue(narrateDream(world, entity), `${entity.name} dreams — `);
  } else {
    enqueue(observeEntity(world, entity), `${entity.name} — `);
  }
}

function doInspect(entity) {
  const e   = entity;
  const div = '─'.repeat(32);
  ui.addLog(div, 'white');
  ui.addLog(`${e.name}  ·  age ${Math.floor(e.age)}  ·  ${e.lifeStage}  ·  ${e.personalityLabel}`, 'cyan');
  ui.addLog(`state: ${e.stateLabel}  mood: ${e.moodLabel}  drama: ${e.dramaticScore}`, 'white');
  ui.addLog(`hunger: ${Math.floor(e.hunger)}/100   energy: ${Math.floor(e.energy)}/100`, 'white');

  if (e.ambition) {
    const status = e.ambitionFulfilled ? '✓ fulfilled' : 'in pursuit';
    ui.addLog(`ambition [${status}]: to ${AMBITION_DESC[e.ambition] ?? e.ambition}`, e.ambitionFulfilled ? 'green' : 'yellow');
  }

  const faction = world.getFactionOf(e);
  if (faction) {
    const others = [...faction.memberIds]
      .filter(id => id !== e.id)
      .map(id => world.entities.find(x => x.id === id && x.alive)?.name)
      .filter(Boolean);
    ui.addLog(`faction: ${faction.name}  (with ${others.join(', ') || 'none'})`, 'cyan');
  }

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

  // ── Global exits ────────────────────────────────────────────
  if (lower === 'quit' || lower === 'q') { ui.screen.destroy(); process.exit(0); }

  // ── Talk mode routing ────────────────────────────────────────
  // If in a talk session, non-system input goes to the soul
  if (talkActive()) {
    if (lower === 'bye' || lower === 'leave' || lower === 'end' || lower === 'endtalk') {
      endTalk(); return;
    }
    // Check if soul died mid-conversation
    if (!talkSession.entity.alive) {
      ui.addLog(`${talkSession.entity.name} is gone.`, 'red');
      endTalk(); return;
    }
    // Route message to soul
    const playerMsg = norm;
    ui.addLog(`{white-fg}[You]{/white-fg} ${playerMsg}`, 'white');
    talkSession.history.push({ role: 'user', content: playerMsg });

    const replyGen = narrateTalkReply(world, talkSession.entity, talkSession.history, playerMsg);
    let fullReply = '';
    ui.openNarrativeLine(`${talkSession.entity.name}  `);
    narratingNow = true;
    try {
      for await (const chunk of replyGen) {
        ui.appendNarrative(chunk);
        fullReply += chunk;
      }
      ui.addLog('', 'white');
      talkSession.history.push({ role: 'assistant', content: fullReply });
    } catch (err) {
      ui.addLog(`Talk error: ${err.message.slice(0, 60)}`, 'red');
    } finally {
      narratingNow = false;
    }
    return;
  }

  // ── Normal commands ──────────────────────────────────────────
  if (lower === 'pause') {
    world.paused = true;
    ui.addLog('Time has stilled.', 'yellow');
    ui.updateTitle(world, speedMult, talkSession?.entity?.name ?? null); ui.render(); return;
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
    ui.updateTitle(world, speedMult, talkSession?.entity?.name ?? null); ui.render(); return;
  }

  if (lower.startsWith('model')) {
    const parts = lower.split(/\s+/);
    if (parts.length < 2) {
      ui.addLog(`Active model: ${getModel()}. Usage: model <name>`, 'yellow'); return;
    }
    setModel(parts[1]);
    ui.addLog(`Model switched to ${getModel()}.`, 'yellow'); return;
  }

  if (lower === 'save') { world.save(); ui.addLog('World saved.', 'yellow'); return; }

  // ── Talk ─────────────────────────────────────────────────────
  if (lower.startsWith('talk ')) {
    const q = norm.slice(5).trim().toLowerCase();
    const e = world.aliveEntities().find(en => en.name.toLowerCase().startsWith(q));
    if (!e) { ui.addLog(`No living soul named "${q}".`, 'red'); return; }
    if (narratingNow) { ui.addLog('Wait for the current narration to finish.', 'yellow'); return; }

    talkSession = { entity: e, history: [] };
    ui.addLog(`─── speaking with ${e.name} ───`, 'yellow');
    ui.addLog(`${e.name} is ${e.stateLabel}, age ${Math.floor(e.age)}. Type your message. "bye" to leave.`, 'white');
    ui.updateTitle(world, speedMult, talkSession?.entity?.name ?? null);

    // Opening line from the soul
    narratingNow = true;
    let opening = '';
    ui.openNarrativeLine(`${e.name}  `);
    try {
      for await (const chunk of narrateTalkOpening(world, e)) {
        ui.appendNarrative(chunk);
        opening += chunk;
      }
      ui.addLog('', 'white');
      talkSession.history.push({ role: 'assistant', content: opening });
    } catch (err) {
      ui.addLog(`Talk error: ${err.message.slice(0, 60)}`, 'red');
    } finally {
      narratingNow = false;
    }
    return;
  }

  // ── World oracle ──────────────────────────────────────────────
  if (lower === 'ask') {
    enqueue(narrateAsk(world), '');
    return;
  }

  // ── Divine interventions ──────────────────────────────────────
  if (lower.startsWith('feed ') || lower.startsWith('calm ') || lower.startsWith('smite ')) {
    const [verb, ...rest] = norm.split(/\s+/);
    const q = rest.join(' ').toLowerCase();
    const e = world.aliveEntities().find(en => en.name.toLowerCase().startsWith(q));
    if (!e) { ui.addLog(`No living soul named "${q}".`, 'red'); return; }

    switch (verb.toLowerCase()) {
      case 'feed':
        e.hunger       = 5;
        e.starvingTicks = 0;
        e.energy = Math.max(e.energy, 30); // feed saves from exhaustion too
        ui.addLog(`You reach down and feed ${e.name}.`, 'yellow');
        break;
      case 'calm':
        e.mood = 85;
        e.energy = Math.min(100, e.energy + 30);
        for (const [id, r] of e.relationships) if (r.type === 'rival') e.setRel(id, 'neutral', 0);
        ui.addLog(`You breathe peace into ${e.name}.`, 'yellow');
        break;
      case 'smite':
        e.alive = false;
        e.remember('struck down by the watcher');
        world.totalDeaths++;
        ui.addLog(`Your judgment falls upon ${e.name}.`, 'red');
        setTimeout(() => { world.entities = world.entities.filter(en => en !== e); }, 4000);
        break;
    }
    enqueue(narrateIntervention(world, verb.toLowerCase(), e), '');
    return;
  }

  // ── Revive ───────────────────────────────────────────────────
  if (lower.startsWith('revive ')) {
    const q    = norm.slice(7).trim().toLowerCase();
    const GRACE = 300000; // 5 minutes after death
    const e    = world.entities.find(en =>
      en.name.toLowerCase().startsWith(q) &&
      !en.alive &&
      en.diedAt &&
      Date.now() - en.diedAt < GRACE
    );

    if (!e) {
      // Check if they're alive (player misspelled or soul is fine)
      const alive = world.aliveEntities().find(en => en.name.toLowerCase().startsWith(q));
      if (alive) { ui.addLog(`${alive.name} still walks — no need.`, 'white'); }
      else        { ui.addLog(`No recently departed soul named "${q}". Act within 5 minutes of death.`, 'red'); }
      return;
    }

    e.alive        = true;
    e.hunger       = 25;
    e.energy       = 60;
    e.mood         = 50;
    e.starvingTicks = 0;
    e.diedAt       = null;
    e.remember('returned from death by the watcher');

    ui.addLog(`${e.name} draws breath again.`, 'yellow');
    enqueue(narrateIntervention(world, 'revive', e), '');
    return;
  }

  // ── Help ─────────────────────────────────────────────────────
  if (lower === 'help') {
    ui.addLog('── observation ─────────────────', 'white');
    ui.addLog('observe <name>    — narrate inner state (or dreams, if sleeping)', 'white');
    ui.addLog('inspect <name>    — full dossier: stats, memory, bonds', 'white');
    ui.addLog('lineage <name>    — show parents, self, and children', 'white');
    ui.addLog('rumors <name>     — what a soul has heard from others', 'white');
    ui.addLog('souls             — list all living souls (with faction)', 'white');
    ui.addLog('factions          — list all factions and inter-faction tension', 'white');
    ui.addLog('ask               — world oracle: what is happening right now', 'white');
    ui.addLog('history           — chronicle of significant events', 'white');
    ui.addLog('── conversation ────────────────', 'white');
    ui.addLog('talk <name>       — speak directly with a soul', 'white');
    ui.addLog('bye               — leave a conversation', 'white');
    ui.addLog('── divine acts ─────────────────', 'white');
    ui.addLog('feed <name>       — give sustenance (resets starvation counter)', 'white');
    ui.addLog('calm <name>       — bring peace, clear rivalries', 'white');
    ui.addLog('smite <name>      — divine judgment', 'white');
    ui.addLog('revive <name>     — pull a soul back from death (within 5 min)', 'white');
    ui.addLog('── world ───────────────────────', 'white');
    ui.addLog('pause / resume    — freeze / unfreeze time', 'white');
    ui.addLog('speed <n>         — set speed multiplier', 'white');
    ui.addLog(`model <name>      — swap Ollama model (active: ${getModel()})`, 'white');
    ui.addLog('save              — save world now', 'white');
    ui.addLog('click map         — observe that soul instantly', 'white');
    ui.addLog('q                 — quit', 'white');
    return;
  }

  if (lower === 'history' || lower === 'chronicle') {
    const h = world.history;
    if (!h.length) { ui.addLog('No history yet — the world is young.', 'white'); return; }
    ui.addLog('── chronicle ───────────────────', 'white');
    for (const entry of h) ui.addLog(`  ${entry.text}`, 'white');
    ui.addLog('────────────────────────────────', 'white');
    return;
  }

  if (lower === 'souls' || lower === 'list') {
    const alive = world.aliveEntities();
    ui.addLog(`Living souls (${alive.length}):`, 'white');
    for (const e of alive) {
      const fName = world.getFactionOf(e)?.name ?? '';
      const fTag  = fName ? ` [${fName}]` : '';
      ui.addLog(`  ${e.name} — ${e.personalityLabel} — age ${Math.floor(e.age)} — ${e.stateLabel}${fTag}`, 'white');
    }
    return;
  }

  if (lower === 'factions') {
    const fList = [...world.factions.values()];
    if (!fList.length) { ui.addLog('No factions have formed yet.', 'white'); return; }
    const div = '─'.repeat(34);
    ui.addLog(div, 'white');
    for (const f of fList) {
      const members = [...f.memberIds]
        .map(id => world.entities.find(e => e.id === id && e.alive))
        .filter(Boolean);
      ui.addLog(`${f.name}  (${members.length} members, since day ${f.foundedDay})`, 'cyan');
      ui.addLog(`  ${members.map(e => e.name).join(' · ')}`, 'white');

      // Tension with other factions
      for (const other of fList) {
        if (other.id === f.id) continue;
        const t = world.factionTension(f, other);
        if (t <= 0) continue;
        const label = t < 0.3 ? 'low' : t < 0.7 ? 'moderate' : t < 1.2 ? 'high' : 'volatile';
        ui.addLog(`  tension with ${other.name}: ${label}`, t >= 0.7 ? 'red' : 'yellow');
      }
    }
    ui.addLog(div, 'white');
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

  // ── Lineage ──────────────────────────────────────────────────
  if (lower.startsWith('lineage ')) {
    const q = norm.slice(8).trim().toLowerCase();
    const e = world.entities.find(en => en.name.toLowerCase().startsWith(q));
    if (!e) { ui.addLog(`No soul named "${q}" found.`, 'red'); return; }

    const div = '─'.repeat(34);
    ui.addLog(div, 'white');
    ui.addLog(`Lineage of ${e.name}`, 'cyan');

    if (e.parents?.length) {
      for (const pid of e.parents) {
        const p = world.entities.find(en => en.id === pid);
        if (!p) continue;
        const s = p.alive ? `alive, age ${Math.floor(p.age)}` : `died age ${Math.floor(p.age)}`;
        ui.addLog(`  Parent  ${p.name} (${p.personalityLabel}) — ${s}`, p.alive ? 'white' : 'red');
      }
    } else {
      ui.addLog(`  Wandered in from beyond the world's edge`, 'white');
    }

    const status = e.alive ? `alive, age ${Math.floor(e.age)}` : `died age ${Math.floor(e.age)}`;
    ui.addLog(`  ▶ ${e.name} (${e.personalityLabel}) — ${status}`, e.alive ? 'cyan' : 'red');

    const children = world.entities.filter(en => en.parents?.includes(e.id));
    for (const c of children) {
      const cs = c.alive ? `alive, age ${Math.floor(c.age)}` : `died age ${Math.floor(c.age)}`;
      ui.addLog(`  Child   ${c.name} (${c.personalityLabel}) — ${cs}`, c.alive ? 'white' : 'red');
    }

    ui.addLog(div, 'white');
    return;
  }

  // ── Rumors ───────────────────────────────────────────────────
  if (lower.startsWith('rumors ') || lower.startsWith('rumours ')) {
    const q = norm.slice(norm.indexOf(' ') + 1).trim().toLowerCase();
    const e = world.entities.find(en => en.name.toLowerCase().startsWith(q));
    if (!e) { ui.addLog(`No soul named "${q}" found.`, 'red'); return; }

    const heard = e.heard ?? [];
    if (!heard.length) { ui.addLog(`${e.name} has heard nothing yet.`, 'white'); return; }
    ui.addLog(`What ${e.name} has heard:`, 'cyan');
    for (const r of heard) ui.addLog(`  ${r.from}: "${r.text}"`, 'white');
    return;
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
  ui.updateTitle(world, speedMult, talkSession?.entity?.name ?? null);
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
ui.updateTitle(world, speedMult, talkSession?.entity?.name ?? null);
ui.render();

setTimeout(tick, tickDelay);
