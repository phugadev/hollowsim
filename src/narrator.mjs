import { NARRATIVE_COOLDOWN, DRAMATIC_THRESHOLD, OLLAMA_URL } from './config.mjs';

// ── Runtime model (swappable via `model` command) ─────────────
let currentModel = 'llama3.2';
export function setModel(name) { currentModel = name; }
export function getModel()     { return currentModel; }

let lastNarration = 0;

// ── Core Ollama stream ────────────────────────────────────────
async function* ollamaStream(prompt, maxTokens = 80) {
  yield* ollamaChat([{ role: 'user', content: prompt }], maxTokens);
}

async function* ollamaChat(messages, maxTokens = 80) {
  let res;
  try {
    res = await fetch(OLLAMA_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:   currentModel,
        messages,
        stream:  true,
        options: { num_predict: maxTokens, temperature: 0.8 },
      }),
    });
  } catch (err) {
    throw new Error(`Ollama unreachable — is it running? (${err.message})`);
  }

  if (!res || !res.ok) {
    const body = await res?.text().catch(() => '');
    throw new Error(`Ollama ${res?.status}: ${body?.slice(0, 80)}`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.message?.content) yield obj.message.content;
        if (obj.done) return;
      } catch { /* skip malformed */ }
    }
  }
}

// ── Prompts ───────────────────────────────────────────────────
function dramaticPrompt(snap, eventType) {
  return `Narrator of a small ancient world called ${snap.worldName}. Day ${snap.worldDay}, ${snap.worldTime}, ${snap.worldSeason}.

${snap.name}, age ${snap.age}: ${snap.state}. Hunger ${snap.hunger}/100. Energy ${snap.energy}/100. Mood: ${snap.mood}. Nature: ${snap.personality}. Bonds: ${snap.bonds}. Memory: ${snap.memory}. Event: ${eventType}.

Write 1-2 sentences of evocative literary narration. Third person. No dialogue. Max 40 words.`;
}

function observePrompt(snap) {
  const ambitionLine = snap.ambition ? `\nAmbition: ${snap.ambition}.` : '';
  const factionLine  = snap.faction  ? ` Faction: ${snap.faction}.`   : '';
  return `Voice of a world called ${snap.worldName}. Day ${snap.worldDay}, ${snap.worldTime}, ${snap.worldSeason}.

${snap.name}, age ${snap.age} (${snap.lifeStage}): ${snap.state}. Hunger ${snap.hunger}/100. Energy ${snap.energy}/100. Fulfillment ${snap.fulfillment}/100. Mood: ${snap.mood}. Nature: ${snap.personality}.${factionLine} Nearby: ${snap.nearby}. Bonds: ${snap.bonds}. Memories: ${snap.memory}.${ambitionLine}

Write 2-3 sentences about their inner state — what they feel, want, or fear. If fulfillment is low, let longing or restlessness show. Let their life stage colour the prose (youth: restless; elder: contemplative). Third person. Literary. Max 60 words.`;
}

function dreamPrompt(snap) {
  const ambitionLine = snap.ambition ? ` Ambition: ${snap.ambition}.` : '';
  return `Voice of a world called ${snap.worldName}. ${snap.name} is sleeping. Day ${snap.worldDay}, ${snap.worldSeason}.

Nature: ${snap.personality}. Life stage: ${snap.lifeStage}. Fulfillment: ${snap.fulfillment}/100. Bonds: ${snap.bonds || 'none'}. Last memories: ${snap.memory || 'nothing notable'}.${ambitionLine}

Write 1-2 sentences describing what ${snap.name} dreams of — symbolic, fragmented, rooted in what they carry. If fulfillment is low, the dream aches. An elder's dreams look backward; a youth's look forward. Third person. Literary. No dialogue. Max 40 words.`;
}

function regretPrompt(snap, regret) {
  return `In ${snap.worldName}, ${snap.name} (${snap.personality}) has just died at age ${snap.age}. Their unresolved thread: ${regret}.

Write 1 sentence — their final unspoken thought, a wish or grief left behind. Third person. Intimate. No dialogue. Max 20 words.`;
}

function eulogyPrompt(snap, deathReason) {
  return `Write a 2-sentence eulogy for ${snap.name}, who died of ${deathReason} in ${snap.worldName} on day ${snap.worldDay}.

They lived ${snap.age} seasons. Nature: ${snap.personality}. Bonds: ${snap.bonds}. Last memories: ${snap.memory}.

Be literary and final. Third person. No dialogue. Max 35 words.`;
}

function factionFormedPrompt(worldName, worldDay, factionName, members) {
  return `In ${worldName}, day ${worldDay}, a new group has formed: the ${factionName}.

Members: ${members.map(e => `${e.name} (${e.personalityLabel})`).join(', ')}.

Write 1 sentence announcing their formation — what draws them together, what they might become. Evocative. No dialogue. Max 20 words.`;
}

function ambitionPrompt(snap) {
  return `In ${snap.worldName}, day ${snap.worldDay}, ${snap.name} (${snap.personality}, ${snap.lifeStage}) has just fulfilled their life's ambition: to ${snap.ambition}.

Write 1 sentence of quiet, earned satisfaction — what this moment feels like for them. Third person. No dialogue. Max 20 words.`;
}

function conflictPrompt(worldName, worldDay, winner, loser) {
  return `In ${worldName}, on day ${worldDay}, ${winner.name} (${winner.personalityLabel}) fought ${loser.name} (${loser.personalityLabel}) and won.

Write 1 sentence narrating this moment. No dialogue. Specific to their natures. Max 25 words.`;
}

function worldEventPrompt(worldName, worldDay, worldSeason, eventType) {
  const tone = {
    drought:  'ominous and dry',
    windfall: 'sudden and abundant',
    storm:    'fierce and cold',
    plague:   'creeping and dreadful',
  }[eventType] ?? 'significant';

  return `In the world of ${worldName}, day ${worldDay}, ${worldSeason}: a ${eventType} has begun.

Write 1 sentence announcing this event in a ${tone} tone. Poetic but brief. Max 20 words. No exclamation marks.`;
}

function arrivalPrompt(worldName, worldDay, worldSeason, name, personality, wasEmpty) {
  const context = wasEmpty
    ? `The world was completely empty — all souls had perished.`
    : `The world is sparse and quiet.`;
  return `In ${worldName}, day ${worldDay}, ${worldSeason}. ${context}

A wanderer named ${name} (${personality}) has arrived at the edge of the world.

Write 1 sentence about their arrival — where they came from or why they walk here. No dialogue. Max 20 words.`;
}

function bondPrompt(worldName, worldDay, nameA, personalityA, nameB, personalityB) {
  return `In ${worldName}, day ${worldDay}, ${nameA} (${personalityA}) and ${nameB} (${personalityB}) have formed a deep bond.

Write 1 sentence about what drew them together. No dialogue. Max 20 words.`;
}

// ── Public generators ─────────────────────────────────────────
export async function* narrateDramatic(world, entity, eventType) {
  yield* ollamaStream(dramaticPrompt(world.getStateSnapshot(entity), eventType));
  lastNarration = Date.now();
}

export async function* observeEntity(world, entity) {
  yield* ollamaStream(observePrompt(world.getStateSnapshot(entity)), 120);
}

export async function* narrateDream(world, entity) {
  yield* ollamaStream(dreamPrompt(world.getStateSnapshot(entity)), 80);
}

export async function* narrateRegret(world, entity, regret) {
  yield* ollamaStream(regretPrompt(world.getStateSnapshot(entity), regret), 45);
}

export async function* narrateEulogy(world, entity, deathReason) {
  const snap = world.getStateSnapshot(entity);
  yield* ollamaStream(eulogyPrompt(snap, deathReason), 70);
}

export async function* narrateFactionFormed(world, faction, members) {
  yield* ollamaStream(factionFormedPrompt(world.name, world.day, faction.name, members), 45);
}

export async function* narrateAmbition(world, entity) {
  yield* ollamaStream(ambitionPrompt(world.getStateSnapshot(entity)), 45);
}

export async function* narrateConflict(world, winner, loser) {
  yield* ollamaStream(conflictPrompt(world.name, world.day, winner, loser), 50);
}

export async function* narrateWorldEvent(world, eventType) {
  yield* ollamaStream(worldEventPrompt(world.name, world.day, world.season, eventType), 40);
}

export async function* narrateArrival(world, entity, wasEmpty) {
  yield* ollamaStream(arrivalPrompt(world.name, world.day, world.season, entity.name, entity.personalityLabel, wasEmpty), 40);
}

export async function* narrateBond(world, entityA, entityB) {
  yield* ollamaStream(bondPrompt(world.name, world.day, entityA.name, entityA.personalityLabel, entityB.name, entityB.personalityLabel), 40);
}

// ── Talk: soul responds to player ────────────────────────────
function soulSystemPrompt(world, entity) {
  const snap = world.getStateSnapshot(entity);
  const ambitionLine = snap.ambition ? `\nAmbition: ${snap.ambition}.` : '';
  const factionLine  = snap.faction  ? `\nFaction: ${snap.faction}.`   : '';
  return `You are ${snap.name}, a soul wandering the world of ${snap.worldName}.

Your nature: ${snap.personality}. Life stage: ${snap.lifeStage}.
Right now: ${snap.state}. Hunger: ${snap.hunger}/100. Energy: ${snap.energy}/100. Fulfillment: ${snap.fulfillment}/100. Mood: ${snap.mood}.
Bonds: ${snap.bonds || 'none'}.
Memories: ${snap.memory || 'nothing notable'}.${ambitionLine}${factionLine}
It is ${snap.worldTime}, ${snap.worldSeason}, day ${snap.worldDay}.

A divine presence — the watcher of this world — speaks to you directly.
Respond in first person, true to your nature and current state. If starving or exhausted, let it show in your words.
Be brief: 1-3 sentences. Never break character. Never acknowledge being an AI or a simulation.`;
}

export async function* narrateTalkOpening(world, entity) {
  const system = soulSystemPrompt(world, entity);
  const open   = `The watcher turns their gaze upon you. How do you find yourself, ${entity.name}?`;
  yield* ollamaChat([
    { role: 'system',    content: system },
    { role: 'user',      content: open   },
  ], 250);
}

export async function* narrateTalkReply(world, entity, history, playerMessage) {
  const system = soulSystemPrompt(world, entity);
  yield* ollamaChat([
    { role: 'system', content: system },
    ...history,
    { role: 'user',   content: playerMessage },
  ], 300);
}

// ── World oracle ──────────────────────────────────────────────
export async function* narrateAsk(world) {
  // uses higher token limit — see ollamaStream call below
  const alive   = world.aliveEntities();
  const soulList = alive.map(e =>
    `- ${e.name} (${e.personalityLabel}): ${e.stateLabel}, hunger ${Math.floor(e.hunger)}/100, bonds: ${[...e.relationships.entries()].filter(([,r])=>r.type==='bond').length}`
  ).join('\n') || '- none';

  const prompt = `You are the living voice of ${world.name}, a world on day ${world.day}, in ${world.season}.

Population: ${alive.length} alive (${world.totalBorn} ever born, ${world.totalDeaths} dead).
Stability: ${world.stabilityLabel}. Active event: ${world.activeEvent?.type || 'none'}.
Oldest alive: ${world.oldestAlive ? `${world.oldestAlive.name}, age ${Math.floor(world.oldestAlive.age)}` : 'none'}.

Souls:
${soulList}

The watcher asks to understand what is happening. Speak as the world itself — vivid, present tense.
2-3 sentences. What is happening right now? What matters? Make it feel alive.`;

  yield* ollamaStream(prompt, 300);
}

// ── Divine interventions ──────────────────────────────────────
export async function* narrateIntervention(world, type, entity) {
  const prompts = {
    feed:  `In ${world.name}, the watcher reaches down and delivers sustenance to ${entity.name} (${entity.personalityLabel}), who was starving. Write 1 sentence narrating this divine act. Poetic. No dialogue. Max 20 words.`,
    calm:  `In ${world.name}, the watcher breathes peace into ${entity.name} (${entity.personalityLabel}), who was troubled. Write 1 sentence. Gentle, quiet. Max 20 words.`,
    smite: `In ${world.name}, the watcher's judgment falls upon ${entity.name} (${entity.personalityLabel}). Write 1 dramatic sentence of divine destruction. No dialogue. Max 20 words.`,
    revive: `In ${world.name}, the watcher pulls ${entity.name} (${entity.personalityLabel}) back from death. Write 1 sentence — the moment of return to life. Miraculous, intimate. No dialogue. Max 20 words.`,
  };
  yield* ollamaStream(prompts[type] ?? prompts.calm, 45);
}

// ── Trigger helpers ───────────────────────────────────────────
export function shouldNarrate(entity) {
  if (Date.now() - lastNarration < NARRATIVE_COOLDOWN) return false;
  return entity.dramaticScore >= DRAMATIC_THRESHOLD;
}

export function dramaticEventLabel(entity) {
  if (entity.starvingTicks > 2)        return 'desperate starvation';
  if (entity.hunger > 85)              return 'near starvation';
  if (entity.energy < 10)              return 'total exhaustion';
  if (entity.age > 120)                return 'approaching end of life';
  if (entity.mood < 20)                return 'deep despair';
  if ((entity.fulfillment ?? 50) < 20) return 'a longing for more than this';
  return 'inner crisis';
}
