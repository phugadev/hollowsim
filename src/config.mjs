export const WORLD_WIDTH  = 80;
export const WORLD_HEIGHT = 28;
export const TICK_MS      = 450;

export const INITIAL_ENTITIES   = 10;
export const MAX_ENTITIES       = 22;
export const FOOD_NODES         = 22;
export const NARRATIVE_COOLDOWN = 22000;
export const DRAMATIC_THRESHOLD = 75;

export const SEASON_LENGTH      = 20;   // days per season
export const SEASONS            = ['spring', 'summer', 'autumn', 'winter'];
export const SAVE_INTERVAL      = 80;   // ticks between auto-saves
export const WORLD_EVENT_CHANCE = 0.0008; // per tick (~every 7.5 min at 1×)

export const OLLAMA_URL   = 'http://localhost:11434/api/chat';
export const OLLAMA_MODEL = 'llama3.2'; // swap to 'gemma4' for richer narration

export const TERRAIN = {
  PLAINS:   '.',
  WATER:    '~',
  MOUNTAIN: '^',
  FOREST:   'T',
};
