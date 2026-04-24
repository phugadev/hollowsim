import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const blessed = require('blessed');

import { WORLD_WIDTH, WORLD_HEIGHT, TERRAIN } from './config.mjs';

const TAG = {
  magenta: '{magenta-fg}', cyan: '{cyan-fg}', yellow: '{yellow-fg}',
  green:   '{green-fg}',   red:  '{red-fg}',  blue:   '{blue-fg}',
  white:   '{white-fg}',
};

const GLYPH = {
  [TERRAIN.PLAINS]:   { ch: '.', tag: '{white-fg}'   },
  [TERRAIN.WATER]:    { ch: '~', tag: '{cyan-fg}'    },
  [TERRAIN.MOUNTAIN]: { ch: '^', tag: '{white-fg}'   },
  [TERRAIN.FOREST]:   { ch: 'T', tag: '{green-fg}'   },
  [TERRAIN.RUINS]:    { ch: '#', tag: '{magenta-fg}' },
};

const SEASON_COLORS = { spring: 'green', summer: 'white', autumn: 'yellow', winter: 'cyan' };
const EVENT_COLORS  = { drought: 'red', windfall: 'green', storm: 'cyan', plague: 'magenta' };

function bar(val, max, len = 5) {
  const n = Math.round(Math.max(0, Math.min(val, max)) / max * len);
  return '█'.repeat(n) + '░'.repeat(len - n);
}

const RIGHT_W   = `100%-${WORLD_WIDTH + 2}`;
const RIGHT_L   = WORLD_WIDTH + 2;
const LIST_H    = Math.ceil((WORLD_HEIGHT + 2) * 0.6);  // ~60% of right panel
const STATS_H   = Math.floor((WORLD_HEIGHT + 2) * 0.4); // ~40%

export class UI {
  constructor() {
    this.screen = blessed.screen({
      smartCSR: true, title: 'HOLLOWS', fullUnicode: true, mouse: true,
    });
    this._logLines = [];
    this._build();
    this._keys();
  }

  _build() {
    const S = this.screen;

    this.title = blessed.box({
      top: 0, left: 0, width: '100%', height: 1,
      tags: true,
      style: { fg: 'white', bg: 'black', bold: true },
    });

    this.map = blessed.box({
      top: 1, left: 0,
      width: WORLD_WIDTH + 2, height: WORLD_HEIGHT + 2,
      border: 'line', label: ' world ', tags: true,
      style: { border: { fg: 'white' }, label: { fg: 'white' } },
    });

    this.entityList = blessed.box({
      top: 1, left: RIGHT_L,
      width: RIGHT_W, height: LIST_H,
      border: 'line', label: ' souls ', tags: true,
      scrollable: true,
      style: { border: { fg: 'white' }, label: { fg: 'white' } },
    });

    this.statsPanel = blessed.box({
      top: 1 + LIST_H, left: RIGHT_L,
      width: RIGHT_W, height: STATS_H,
      border: 'line', label: ' world stats ', tags: true,
      style: { border: { fg: 'white' }, label: { fg: 'white' } },
    });

    this.log = blessed.box({
      top: WORLD_HEIGHT + 3, left: 0,
      width: '100%', height: `100%-${WORLD_HEIGHT + 4}`,
      border: 'line', label: ' chronicle ', tags: true,
      scrollable: true, alwaysScroll: true,
      style: { border: { fg: 'white' }, label: { fg: 'white' } },
    });

    this.input = blessed.textbox({
      bottom: 0, left: 0, width: '100%', height: 1,
      inputOnFocus: true,
      style: { fg: 'green', bg: 'black' },
    });

    [this.title, this.map, this.entityList, this.statsPanel, this.log, this.input]
      .forEach(w => S.append(w));

    S.render();
  }

  _keys() {
    this._inputOpen = false;
    this.screen.key(['q', 'C-c'], () => { this.screen.destroy(); process.exit(0); });
    this.screen.key([':', '/'], () => {
      this._inputOpen = true;
      this.input.setValue('');
      this.screen.program.disableMouse(); // prevent escape sequences bleeding into input
      this.input.focus();
      this.screen.render();
    });
    // Chronicle scroll — [ to go up, ] to go down
    this.screen.key(['['], () => { if (!this._inputOpen) { this.log.scroll(-5); this.screen.render(); } });
    this.screen.key([']'], () => { if (!this._inputOpen) { this.log.scroll(5);  this.screen.render(); } });
  }

  _restoreMouse() {
    this.screen.program.enableMouse();
  }

  onCommand(handler) {
    this.input.on('submit', value => {
      this._inputOpen = false;
      this.input.clearValue();
      this.input.cancel();
      this._restoreMouse();
      this.screen.render();
      // Strip any stray non-printable chars just in case
      const cmd = value.replace(/[^\x20-\x7E]/g, '').trim();
      if (cmd) handler(cmd);
    });
    this.input.key(['escape'], () => {
      this._inputOpen = false;
      this.input.clearValue();
      this.input.cancel();
      this._restoreMouse();
      this.screen.render();
    });
  }

  onMapClick(handler) {
    this.map.on('click', data => {
      const wx = data.x - 1;
      const wy = data.y - 2;
      if (wx >= 0 && wx < WORLD_WIDTH && wy >= 0 && wy < WORLD_HEIGHT) handler(wx, wy);
    });
  }

  // ── render ────────────────────────────────────────────────
  renderWorld(world) {
    const eMap = new Map();
    const fSet = new Set(world.foodNodes.keys());
    for (const e of world.aliveEntities()) eMap.set(`${e.x},${e.y}`, e);

    let out = '';
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let x = 0; x < WORLD_WIDTH; x++) {
        const key = `${x},${y}`;
        const e   = eMap.get(key);
        if (e) {
          out += `${TAG[e.color] ?? TAG.white}${e.displayChar}{/}`;
        } else if (fSet.has(key)) {
          out += `{yellow-fg}*{/}`;
        } else {
          const g = GLYPH[world.terrain[y][x]] ?? GLYPH[TERRAIN.PLAINS];
          out += `${g.tag}${g.ch}{/}`;
        }
      }
      out += '\n';
    }
    this.map.setContent(out);
  }

  renderEntities(world) {
    const alive = world.aliveEntities();
    const GRACE = 300000;
    let out = '';

    for (const e of alive) {
      const col  = TAG[e.color] ?? TAG.white;
      // F = fullness (inverted hunger — full bar = well fed, empty = starving)
      const hTag = e.hunger > 80 ? '{red-fg}' : e.hunger > 55 ? '{yellow-fg}' : '{green-fg}';
      const eTag = e.energy < 20 ? '{red-fg}' : '{cyan-fg}';
      const ful  = e.fulfillment ?? 50;
      const vTag = ful < 25 ? '{red-fg}' : ful < 50 ? '{yellow-fg}' : '{magenta-fg}';
      out += `${col}${e.name}{/} {white-fg}d${Math.floor(e.age)}{/} `;
      out += `${hTag}F${bar(100 - e.hunger, 100, 4)}{/} ${eTag}E${bar(e.energy, 100, 4)}{/} ${vTag}V${bar(ful, 100, 4)}{/} `;
      out += `{white-fg}[${e.stateLabel}]{/}\n`;
    }

    // Show recently dead souls with revive countdown
    const recentDead = world.entities.filter(e =>
      !e.alive && e.diedAt && Date.now() - e.diedAt < GRACE
    );
    for (const e of recentDead) {
      const secsLeft = Math.ceil((GRACE - (Date.now() - e.diedAt)) / 1000);
      const minsLeft = Math.ceil(secsLeft / 60);
      out += `{red-fg}† ${e.name}{/} {yellow-fg}revive: ${minsLeft}m left{/}\n`;
    }

    if (!alive.length && !recentDead.length) out = '{red-fg}The world is silent.{/}';
    this.entityList.setContent(out);
    this.entityList.setLabel(` souls (${alive.length}) `);
  }

  renderStats(world) {
    const sc   = SEASON_COLORS[world.season] ?? 'white';
    const alive = world.aliveEntities();
    const oldest = world.oldestAlive;

    let out = '';
    out += `{${sc}-fg}${world.season}{/}  {white-fg}stability: ${world.stabilityLabel}{/}\n`;
    out += `{white-fg}alive: ${alive.length}  born: ${world.totalBorn}  deaths: ${world.totalDeaths}{/}\n`;
    out += `{white-fg}bonds formed: ${world.totalBonds}{/}\n`;
    out += `{white-fg}oldest alive: ${oldest ? `${oldest.name} (${Math.floor(oldest.age)})` : '—'}{/}\n`;
    out += `{white-fg}oldest ever:  ${world.oldestEver ? `${world.oldestEver.name} (${world.oldestEver.age})` : '—'}{/}\n`;

    if (world.activeEvent) {
      const ev = world.activeEvent;
      const ec = EVENT_COLORS[ev.type] ?? 'white';
      const daysLeft = ev.endsDay - world.day;
      out += `\n{${ec}-fg}! ${ev.type.toUpperCase()} (${daysLeft}d remaining){/}\n`;
    }

    this.statsPanel.setContent(out);
  }

  updateTitle(world, speedMult = 1, talkName = null) {
    const timeTags = { dawn: '{yellow-fg}', day: '{white-fg}', dusk: '{magenta-fg}', night: '{blue-fg}' };
    const sc   = SEASON_COLORS[world.season] ?? 'white';
    const tt   = timeTags[world.time] ?? '{white-fg}';
    const spd  = speedMult !== 1 ? ` {yellow-fg}×${speedMult}{/}` : '';
    const pse  = world.paused ? ' {yellow-fg}[PAUSED]{/}' : '';
    const evt  = world.activeEvent ? ` {red-fg}[${world.activeEvent.type}]{/}` : '';
    const talk = talkName ? ` {green-fg}[talking to ${talkName}]{/}` : '';
    this.title.setContent(
      ` {bold}HOLLOWSIM{/bold} — {cyan-fg}${world.name}{/} — Day ${world.day} — ${tt}${world.time}{/} — {${sc}-fg}${world.season}{/}${evt}${talk}${spd}${pse}`
    );
  }

  // ── log ───────────────────────────────────────────────────
  addLog(text, color = 'white') {
    this._logLines.push(`{${color}-fg}${text}{/}`);
    if (this._logLines.length > 120) this._logLines.shift();
    this._flushLog();
  }

  _flushLog() {
    this.log.setContent(this._logLines.join('\n'));
    this.log.setScrollPerc(100);
  }

  openNarrativeLine(prefix = '') {
    this._logLines.push(`{magenta-fg}✦ ${prefix}{/}`);
    this._narrativeIdx = this._logLines.length - 1;
    this._narrativeBuf = prefix;
    this._flushLog();
  }

  appendNarrative(text) {
    this._narrativeBuf += text;
    this._logLines[this._narrativeIdx] = `{magenta-fg}✦ ${this._narrativeBuf}{/}`;
    this._flushLog();
    this.screen.render();
  }

  render() { this.screen.render(); }
}
