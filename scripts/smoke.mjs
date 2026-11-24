// One real call per engine, to see what the unit tests can only assume: why a response
// stopped, what max_tokens was sent, which JSON path ran, and whether the ICU structure
// sentinels come back intact. It costs a few cents and is run by hand with your own keys:
//
//   pnpm build && ANTHROPIC_API_KEY=… OPENAI_API_KEY=… GEMINI_API_KEY=… pnpm smoke [--runs N]
//
// An engine whose key variable is unset prints SKIP. Never part of the gate or CI, and not
// shipped: `files` in package.json lists dist only. Only the fields printed below are copied
// out of a request or response; headers and keys are never read.
import { existsSync } from 'node:fs';

const ENGINES = [
  { name: 'anthropic', env: 'ANTHROPIC_API_KEY', model: 'claude-haiku-4-5-20251001', modelEnv: 'SMOKE_MODEL_ANTHROPIC' },
  { name: 'openai', env: 'OPENAI_API_KEY', model: 'gpt-4o-mini', modelEnv: 'SMOKE_MODEL_OPENAI' },
  { name: 'gemini', env: 'GEMINI_API_KEY', model: 'gemini-2.5-flash', modelEnv: 'SMOKE_MODEL_GEMINI' },
];

const SOURCE = {
  greeting: 'Welcome back, {name}!',
  inbox: '{count, plural, one {# new message} other {# new messages}}',
  joined: '{gender, select, male {He joined} female {She joined} other {They joined}} the team today',
  save: 'Save changes',
  nested: { hint: 'You have {count, plural, =0 {no unread items} one {one unread item} other {# unread items}}.' },
  about:
    'Loqui translates your locale files with a language model, keeps your placeholders intact and only sends what changed since the last run.',
};

const SENTINEL = /⟦[^⟦⟧]*⟧/g;

function runsFromArgs(argv) {
  const at = argv.indexOf('--runs');
  if (at === -1) return 1;
  const runs = Number(argv[at + 1]);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error('--runs takes a whole number of at least 1.');
    process.exit(1);
  }
  return runs;
}

function countSentinels(text) {
  const counts = new Map();
  for (const [token] of text.matchAll(SENTINEL)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Wraps fetch for one engine's run; what it keeps is the status and the bodies, never a header. */
function recordFetch(calls) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const response = await realFetch(input, init);
    const resText = await response.clone().text();
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      status: response.status,
      reqText: typeof init?.body === 'string' ? init.body : '',
      resText,
    });
    return response;
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** The strings a request asked to have translated: the JSON object in the user's message. */
function sentChunk(name, request) {
  const text =
    name === 'gemini' ? request?.contents?.at(-1)?.parts?.[0]?.text : request?.messages?.at(-1)?.content;
  if (typeof text !== 'string') return undefined;
  return parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

/** The model's answer as locale → key → string, wherever the engine puts it. */
function answerOf(name, response) {
  if (name === 'anthropic') {
    const tool = response?.content?.find((block) => block.type === 'tool_use');
    if (tool) return tool.input;
    return parse(response?.content?.find((block) => block.type === 'text')?.text ?? '');
  }
  const text = name === 'openai' ? response?.choices?.[0]?.message?.content : response?.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof text === 'string' ? parse(text) : undefined;
}

/** What one engine's recorded calls say, as plain `key: value` lines. */
function describeCalls(name, calls) {
  const lines = [];
  const lookups = calls.filter((call) => call.method === 'GET' && call.path.includes('/models/'));
  const requests = calls.filter((call) => call.method === 'POST');

  for (const lookup of lookups) {
    const answer = parse(lookup.resText);
    lines.push(`models lookup: HTTP ${lookup.status}, max_tokens ${JSON.stringify(answer?.max_tokens ?? null)}`);
  }

  let sent = 0;
  let intact = 0;
  for (const [i, call] of requests.entries()) {
    const request = parse(call.reqText);
    const response = parse(call.resText);
    const label = `request ${i + 1}`;
    lines.push(`${label}: HTTP ${call.status}`);

    if (name === 'anthropic') {
      lines.push(`${label} max_tokens sent: ${request?.max_tokens ?? 'none'}`);
      lines.push(`${label} stop_reason: ${response?.stop_reason ?? 'none'}`);
      lines.push(`${label} path: ${request?.tools ? 'tool_use (strict schema)' : 'text (prompt-based JSON)'}`);
      lines.push(
        `${label} answered as: ${response?.content?.some((block) => block.type === 'tool_use') ? 'tool_use block' : 'text block'}`,
      );
    } else if (name === 'openai') {
      lines.push(`${label} max tokens sent: ${request?.max_tokens ?? request?.max_completion_tokens ?? 'none'}`);
      lines.push(`${label} finish_reason: ${response?.choices?.[0]?.finish_reason ?? 'none'}`);
      lines.push(`${label} path: response_format ${request?.response_format?.type ?? 'none'}`);
    } else {
      lines.push(`${label} max tokens sent: ${request?.generationConfig?.maxOutputTokens ?? 'none'}`);
      lines.push(`${label} finishReason: ${response?.candidates?.[0]?.finishReason ?? 'none'}`);
      lines.push(`${label} path: ${request?.generationConfig?.responseSchema ? 'responseSchema' : 'mime type only'}`);
    }

    // Sentinel indexes restart in every string, so each string is compared with its own answer.
    const chunk = sentChunk(name, request);
    const answer = answerOf(name, response);
    for (const [key, text] of Object.entries(chunk ?? {})) {
      const wentOut = countSentinels(text);
      if (wentOut.size === 0) continue;
      for (const locale of Object.keys(answer ?? {})) {
        sent++;
        const cameBack = countSentinels(String(answer[locale]?.[key] ?? ''));
        const same = cameBack.size === wentOut.size && [...wentOut].every(([token, n]) => cameBack.get(token) === n);
        if (same) intact++;
      }
    }
  }
  return { lines, sent, intact };
}

async function smokeOne(translateObject, engine, runs) {
  const calls = [];
  const restore = recordFetch(calls);
  const outcomes = [];
  try {
    for (let run = 0; run < runs; run++) {
      try {
        const result = await translateObject(SOURCE, {
          from: 'en',
          to: ['es', 'pt'],
          config: { engine: engine.name, model: process.env[engine.modelEnv] ?? engine.model, splitToken: 4000 },
          force: true,
        });
        const mismatches = result.stats.warnings.filter((w) => w.code === 'PLACEHOLDER_MISMATCH').length;
        outcomes.push({ ok: true, mismatches, requests: result.stats.apiRequests });
      } catch (err) {
        outcomes.push({ ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    restore();
  }

  const { lines, sent, intact } = describeCalls(engine.name, calls);
  const succeeded = outcomes.filter((o) => o.ok).length;
  console.log(`== ${engine.name} (${process.env[engine.modelEnv] ?? engine.model})`);
  console.log(`runs: ${runs}, succeeded: ${succeeded}`);
  for (const outcome of outcomes) {
    if (!outcome.ok) console.log(`failed: ${outcome.message}`);
  }
  for (const line of lines) console.log(line);
  console.log(`answers carrying sentinels: ${sent}, sentinels back intact in: ${intact}`);
  console.log(
    `loqui PLACEHOLDER_MISMATCH warnings: ${outcomes.reduce((total, o) => total + (o.ok ? o.mismatches : 0), 0)}`,
  );
  return succeeded;
}

const dist = new URL('../dist/lib.js', import.meta.url);
if (!existsSync(dist)) {
  console.error('dist/ is missing: run `pnpm build` first.');
  process.exit(1);
}
const { translateObject } = await import(dist.href);
const runs = runsFromArgs(process.argv.slice(2));

let failed = false;
for (const engine of ENGINES) {
  if (!process.env[engine.env]) {
    console.log(`== ${engine.name}\nSKIP: ${engine.env} is not set`);
    continue;
  }
  const succeeded = await smokeOne(translateObject, engine, runs);
  if (succeeded < runs) failed = true;
}
process.exitCode = failed ? 1 : 0;
