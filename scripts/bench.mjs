// Counts what a translation run costs in requests and values, not seconds: the mock
// engine answers at once, so the numbers are identical on every run and every machine.
// Run through `pnpm bench`, which compiles the sources to .dist-test first.
import { maskPlaceholders } from '../.dist-test/placeholder.js';
import { translateJson } from '../.dist-test/translator.js';
import { CONFIG_DEFAULTS } from '../.dist-test/types.js';
import { flatten, unflatten } from '../.dist-test/utils/json.js';

const LOCALES = ['fr', 'de', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'fi', 'pl'];
const SECTIONS = 10;
const GROUPS = 25;
const KEYS_PER_GROUP = 20;
const SEED = 20260101;
const WORDS = ['save', 'cancel', 'account', 'profile', 'settings', 'invoice', 'order', 'shipping', 'password', 'email'];

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 5,000 strings nested three levels deep, about 10% carrying a {{name}} placeholder. */
function buildSource() {
  const random = mulberry32(SEED);
  const pick = () => WORDS[Math.floor(random() * WORDS.length)];
  const doc = {};
  for (let s = 0; s < SECTIONS; s++) {
    const section = {};
    for (let g = 0; g < GROUPS; g++) {
      const group = {};
      for (let k = 0; k < KEYS_PER_GROUP; k++) {
        const text = `${pick()} the ${pick()} for ${pick()}`;
        group[`k${k}`] = random() < 0.1 ? `${text} {{name}}` : text;
      }
      section[`g${g}`] = group;
    }
    doc[`s${s}`] = section;
  }
  return doc;
}

/** Resolves at once and echoes each value per locale, counting what it was asked for. */
function makeEngine(counts) {
  return {
    async translateChunk(chunk, locales) {
      counts.requests++;
      counts.values += Object.keys(chunk.keys).length * locales.length;
      const result = {};
      for (const locale of locales) {
        result[locale] = {
          keys: Object.fromEntries(Object.entries(chunk.keys).map(([key, value]) => [key, `${locale}: ${value}`])),
        };
      }
      return result;
    },
  };
}

const sourceDoc = buildSource();
const flatDoc = flatten(sourceDoc);
const sourceFlat = flatDoc.strings;
const keys = Object.keys(sourceFlat);
const translated = (locale) => Object.fromEntries(keys.map((key) => [key, `${locale}: ${sourceFlat[key]}`]));
const without = (flat, dropped) => {
  const copy = { ...flat };
  for (const key of dropped) delete copy[key];
  return copy;
};

/** 500 keys, each missing from a seeded-random 1 to 3 of the ten locales. */
function scatter() {
  const random = mulberry32(SEED + 1);
  const missing = Object.fromEntries(LOCALES.map((locale) => [locale, []]));
  const needed = [];
  for (let i = 0; i < 500; i++) {
    const key = keys[i * 10];
    needed.push(key);
    const pool = [...LOCALES];
    const count = 1 + Math.floor(random() * 3);
    for (let n = 0; n < count; n++) missing[pool.splice(Math.floor(random() * pool.length), 1)[0]].push(key);
  }
  return { missing, needed, activeLocales: LOCALES.filter((locale) => missing[locale].length > 0).length };
}

const scattered = scatter();

const scenarios = [
  {
    name: 'A cold',
    existing: {},
  },
  {
    // nine locales complete, the tenth empty, and one of the nine missing one key
    name: 'B new locale',
    existing: Object.fromEntries(
      LOCALES.slice(0, 9).map((locale) => [locale, locale === 'fr' ? without(translated(locale), [keys[2500]]) : translated(locale)]),
    ),
  },
  {
    // all ten complete, except that each misses a different 50 keys
    name: 'C fragmented',
    existing: Object.fromEntries(
      LOCALES.map((locale, i) => [locale, without(translated(locale), keys.slice(i * 50, (i + 1) * 50))]),
    ),
  },
  {
    // all ten complete, except that each of 500 keys is missing from 1 to 3 locales
    name: 'D scattered',
    existing: Object.fromEntries(LOCALES.map((locale) => [locale, without(translated(locale), scattered.missing[locale])])),
  },
];

async function runScenario({ name, existing }) {
  const counts = { requests: 0, values: 0 };
  const start = performance.now();
  const { stats } = await translateJson({
    sourceFlat,
    from: 'en',
    to: LOCALES,
    namespace: 'bench',
    config: { ...CONFIG_DEFAULTS },
    existing,
    engine: makeEngine(counts),
  });
  return { name, requests: counts.requests, requested: counts.values, kept: stats.keysTranslated, ms: performance.now() - start };
}

/** CPU time (user + system) of `fn`, after one warm-up pass. */
function cpuMs(fn) {
  fn();
  const before = process.cpuUsage();
  fn();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

const rows = [];
const realWrite = process.stderr.write;
// The translator logs every chunk and warning to stderr; that would drown the table.
process.stderr.write = () => true;
try {
  for (const scenario of scenarios) rows.push(await runScenario(scenario));
} finally {
  process.stderr.write = realWrite;
}

const cpu = {
  flatten: cpuMs(() => flatten(sourceDoc)),
  unflatten: cpuMs(() => unflatten(flatDoc)),
  maskPlaceholders: cpuMs(() => {
    for (const value of Object.values(sourceFlat)) maskPlaceholders(value);
  }),
};

const pad = (value, width) => String(value).padStart(width);
console.log(`fixture: ${keys.length} keys, ${LOCALES.length} locales, seed ${SEED}, splitToken ${CONFIG_DEFAULTS.splitToken}\n`);
console.log(`${'scenario'.padEnd(14)}${pad('requests', 10)}${pad('values requested', 18)}${pad('values kept', 13)}${pad('wall ms', 10)}`);
for (const row of rows) {
  console.log(
    `${row.name.padEnd(14)}${pad(row.requests, 10)}${pad(row.requested, 18)}${pad(row.kept, 13)}${pad(row.ms.toFixed(0), 10)}`,
  );
}
// What the run asked for before each key went only to the locales that need it: every
// needed key to every active locale, at most 90 values per request. Derived, not measured.
const perRequest = Math.floor(90 / scattered.activeLocales);
console.log(
  `${'D (old rule)'.padEnd(14)}${pad(Math.ceil(scattered.needed.length / perRequest), 10)}${pad(scattered.needed.length * scattered.activeLocales, 18)}${pad('derived', 13)}`,
);
console.log('\ncpu ms over the whole fixture, after one warm-up pass');
for (const [name, ms] of Object.entries(cpu)) console.log(`${name.padEnd(18)}${ms.toFixed(1)}`);
