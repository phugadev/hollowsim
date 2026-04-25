const STARTS = ['Ae','Bri','Cal','Dyr','En','Fen','Gor','Hel','Il','Jor','Kel',
                 'Lor','Myn','Nyx','Or','Pax','Rae','Sol','Tor','Val','Wyn','Xel','Yar','Zel'];
const ENDS   = ['an','en','in','on','ael','iel','ara','ira','is','us','ax','ix',
                'or','ar','el','al','il','yn','wyn','ith','eth','oth'];

const WORLD_PARTS = [
  ['Ael','Vel','Oss','Fen','Pale','Grey','Ash','Dusk','Mil','Cyr'],
  ['moor','mark','reach','basin','deep','vale','hollow','drift','mere','fen'],
];

const used = new Set();

export function generateName() {
  let name, attempts = 0;
  do {
    const s = STARTS[Math.floor(Math.random() * STARTS.length)];
    const e = ENDS[Math.floor(Math.random() * ENDS.length)];
    name = s + e;
    attempts++;
  } while (used.has(name) && attempts < 100);
  used.add(name);
  return name;
}

export function generateWorldName() {
  const a = WORLD_PARTS[0][Math.floor(Math.random() * WORLD_PARTS[0].length)];
  const b = WORLD_PARTS[1][Math.floor(Math.random() * WORLD_PARTS[1].length)];
  return a + b;
}

const FACTION_ADJ  = ['Amber','Stone','Ash','Iron','Ember','Thorn','Pale','Silver','Briar','Dusk','Hollow','Grey','Moss','Cinder','Reed'];
const FACTION_NOUN = ['Circle','Lodge','House','Kin','Order','Hold','Root','Watch','Fold','Rest','Walk','Band'];

export function generateFactionName() {
  const adj  = FACTION_ADJ [Math.floor(Math.random() * FACTION_ADJ.length)];
  const noun = FACTION_NOUN[Math.floor(Math.random() * FACTION_NOUN.length)];
  return `${adj} ${noun}`;
}
