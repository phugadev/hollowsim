# hollows

A living world simulator that runs in your terminal.

Souls are born, wander, eat, sleep, form bonds, fight, and die — all simulated in real time. Significant moments are narrated by a local AI model via [Ollama](https://ollama.com), so the world generates its own stories without any API costs.

![hollows screenshot](screenshot.png)

---

## Requirements

- [Node.js](https://nodejs.org) v18+
- [Ollama](https://ollama.com) running locally with at least one model pulled

```
ollama pull llama3.2
```

---

## Setup

```bash
git clone https://github.com/phugadev/hollows
cd hollows
npm install
npm start
```

On first run you'll be asked to name your world. The world is saved automatically and reloads on every subsequent run.

---

## How it works

The simulation runs as a pure code engine — no AI involved in the core loop. Ollama is called only for narrative moments:

| Trigger | Narration |
|---|---|
| A soul nears starvation or death | 1-2 sentence dramatic narration |
| A soul dies | Eulogy based on their life |
| Two souls fight | Conflict scene |
| A world event begins (drought, plague…) | Opening line |
| Two souls form a deep bond | Bond story |
| A wanderer arrives at the world's edge | Arrival narration |
| `observe <name>` / click on map | Inner state narration (or dream narration if sleeping) |
| `ask` | World oracle — Ollama reads the full world state |
| `talk <name>` | Full conversation with a soul in character |

The world keeps running while narrations stream in. Events queue up so nothing is dropped.

---

## Commands

Press `:` or `/` to enter a command.

**Observation**

| Command | Description |
|---|---|
| `observe <name>` | Narrate a soul's inner state (dream if sleeping) |
| `inspect <name>` | Full dossier: stats, relationships, memory |
| `souls` | List all living souls |
| `ask` | World oracle — Ollama narrates what's happening right now |
| `history` | Chronicle of significant events since the world began |

**Conversation**

| Command | Description |
|---|---|
| `talk <name>` | Speak directly with a soul — they respond in character |
| `bye` | Leave a conversation |

**Divine intervention**

| Command | Description |
|---|---|
| `feed <name>` | Deliver sustenance to a starving soul |
| `calm <name>` | Bring peace — boosts mood, clears rivalries |
| `smite <name>` | Divine judgment |

**World**

| Command | Description |
|---|---|
| `pause` / `resume` | Freeze / unfreeze time |
| `speed <n>` | Speed multiplier — e.g. `speed 2`, `speed 0.5` |
| `model <name>` | Swap Ollama model live — e.g. `model gemma4` |
| `save` | Save world state now |
| `q` | Quit |

Click any soul letter on the map to observe them instantly.

---

## Configuration

Edit `src/config.mjs` to change world size, simulation speed, season length, or the default Ollama model.

```js
export const OLLAMA_MODEL = 'llama3.2'; // swap to 'gemma4' for richer narration
export const WORLD_WIDTH  = 50;
export const WORLD_HEIGHT = 20;
export const SEASON_LENGTH = 20;        // days per season
```

The world state is saved to `world.json` in the project root (gitignored). Delete it to start a new world.

---

## World mechanics

**Souls** have hunger, energy, mood, and three personality traits — boldness, empathy, curiosity — that drive their behaviour. They wander, seek food, sleep, socialise, and form rivalries.

**Seasons** cycle every 20 days. Winter raises hunger rates and stops births. Spring drops hunger and accelerates bonding.

**World events** — drought, windfall, storm, plague — trigger randomly and reshape conditions for several days.

**Conflict** breaks out when bold souls encounter rivals. Winners and losers are tracked in memory and relationships.

**Births** happen when two deeply bonded souls are near each other, weighted by season.

---

## Models

| Model | Size | Character |
|---|---|---|
| `llama3.2` | 2 GB | Fast, capable, good for quick sessions |
| `gemma4` | 9.6 GB | Richer prose, slower on M1 |

Switch mid-session with `model <name>`.

---

## License

MIT
