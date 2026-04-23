import { NARRATIVE_COOLDOWN, DRAMATIC_THRESHOLD, OLLAMA_URL } from './config.mjs';

// ── Runtime model (swappable via `model` command) ─────────────
let currentModel = 'llama3.2';
export function setModel(name) { currentModel = name; }
export function getModel()     { return currentModel; }

let lastNarration = 0;

// ── Core Ollama stream ────────────────────────────────────────
async function* ollamaStream(prompt, maxTokens = 80) {
  let res;
  try {
    res = await fetch(OLLAMA_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:   currentModel,
        messages:[{ role: 'user', content: prompt }],
        stream:  true,
        options: { num_predict: maxTokens, temperature: 0.8 },
      }),
    });
  } catch (err) {
    throw new Error(`Ollama unreachable — is it running? (${err.message})`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 80)}`);
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
  return `Voice of a world called ${snap.worldName}. Day ${snap.worldDay}, ${snap.worldTime}, ${snap.worldSeason}.

${snap.name}, age ${snap.age}: ${snap.state}. Hunger ${snap.hunger}/100. Energy ${snap.energy}/100. Mood: ${snap.mood}. Nature: ${snap.personality}. Nearby: ${snap.nearby}. Bonds: ${snap.bonds}. Memories: ${snap.memory}.

Write 2-3 sentences about their inner state — what they feel, want, or fear. Third person. Literary. Max 60 words.`;
}

function eulogyPrompt(snap, deathReason) {
  return `Write a 2-sentence eulogy for ${snap.name}, who died of ${deathReason} in ${snap.worldName} on day ${snap.worldDay}.

They lived ${snap.age} seasons. Nature: ${snap.personality}. Bonds: ${snap.bonds}. Last memories: ${snap.memory}.

Be literary and final. Third person. No dialogue. Max 35 words.`;
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

export async function* narrateEulogy(world, entity, deathReason) {
  const snap = world.getStateSnapshot(entity);
  yield* ollamaStream(eulogyPrompt(snap, deathReason), 70);
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

// ── Trigger helpers ───────────────────────────────────────────
export function shouldNarrate(entity) {
  if (Date.now() - lastNarration < NARRATIVE_COOLDOWN) return false;
  return entity.dramaticScore >= DRAMATIC_THRESHOLD;
}

export function dramaticEventLabel(entity) {
  if (entity.starvingTicks > 2) return 'desperate starvation';
  if (entity.hunger > 85)       return 'near starvation';
  if (entity.energy < 10)       return 'total exhaustion';
  if (entity.age > 120)         return 'approaching end of life';
  if (entity.mood < 20)         return 'deep despair';
  return 'inner crisis';
}
