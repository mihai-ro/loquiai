import { HELP_TEXT, unknownFlag } from './cli-args.js';
import { LoquiError } from './errors.js';
import { hashValue, isV2Sidecar, ownerId, readOwners } from './hasher.js';
import { loadSource, resolveConfig, resolveTargets, sidecarPath } from './project.js';
import { isMemoryKey, memoryKey, saveTranslationMemory } from './translation-memory.js';
import type { FlatTranslations, TranslationMemory } from './types.js';
import { readJson, writeJson } from './utils/json.js';

const VALUE_FLAGS = new Set(['--input', '--from', '--to', '--hash-file', '--translation-memory-file', '--config']);

export interface MigrateArgs {
  inputs: string[];
  from: string | null;
  to: string | null;
  config: string | null;
  hashFile: string | null;
  translationMemoryFile: string | null;
  help: boolean;
}

/** `loqui migrate` takes several inputs, which the main parser refuses, so it reads its own. */
export function parseMigrateArgs(tokens: string[]): MigrateArgs {
  const args: MigrateArgs = {
    inputs: [],
    from: null,
    to: null,
    config: null,
    hashFile: null,
    translationMemoryFile: null,
    help: false,
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (!token.startsWith('-')) {
      args.inputs.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    if (!VALUE_FLAGS.has(name)) throw unknownFlag(token);
    let value: string | undefined = eq === -1 ? tokens[++i] : token.slice(eq + 1);
    if (value === undefined || (eq === -1 && value.startsWith('--'))) {
      throw new LoquiError('INVALID_USAGE', `${name} needs a value.`);
    }
    value = value.trim();
    if (name === '--input') args.inputs.push(value);
    else if (name === '--from') args.from = value;
    else if (name === '--to') args.to = value;
    else if (name === '--hash-file') args.hashFile = value;
    else if (name === '--translation-memory-file') args.translationMemoryFile = value;
    else args.config = value;
  }
  return args;
}

interface MigratedInput {
  inputPath: string;
  sourceFlat: FlatTranslations;
}

/** The inputs that share one sidecar file, keyed by that file's path. */
function groupBy(inputs: MigratedInput[], pathOf: (input: MigratedInput) => string): Map<string, MigratedInput[]> {
  const groups = new Map<string, MigratedInput[]>();
  for (const input of inputs) {
    const file = pathOf(input);
    groups.set(file, [...(groups.get(file) ?? []), input]);
  }
  return groups;
}

function migrateSidecar(file: string, group: MigratedInput[], to: string[]): string {
  const raw = readJson(file);
  if (Object.keys(raw).length === 0) return `${file}: not found, skipped`;
  if (!isV2Sidecar(raw)) return `${file}: already v3, unchanged`;
  const owners = Object.fromEntries(
    group.map((input) => [ownerId(file, input.inputPath), Object.keys(input.sourceFlat)]),
  );
  writeJson(file, { ...Object.fromEntries(to.map((locale) => [locale, { ...raw }])), $owners: owners });
  return `${file}: converted ${Object.keys(raw).length} key(s) to ${to.join(', ')} for ${group.length} input(s)`;
}

function migrateMemory(file: string, group: MigratedInput[], from: string): string {
  const raw = readJson(file) as TranslationMemory;
  if (Object.keys(raw).length === 0) return `${file}: not found, skipped`;
  const old = Object.keys(raw).filter((key) => !key.startsWith('$') && !isMemoryKey(key));
  if (old.length === 0) return `${file}: already v3, unchanged`;

  // v2 keyed memory by the 8-character hash of the string, which only the inputs can undo.
  const current = new Map<string, string[]>();
  for (const { sourceFlat } of group) {
    for (const [flatKey, value] of Object.entries(sourceFlat)) {
      const hash = hashValue(value);
      current.set(hash, [...new Set([...(current.get(hash) ?? []), memoryKey(value, flatKey, from)])]);
    }
  }
  const migrated: TranslationMemory = Object.fromEntries(Object.entries(raw).filter(([key]) => isMemoryKey(key)));
  let dropped = 0;
  for (const key of old) {
    const targets = current.get(key) ?? [];
    if (targets.length === 0) dropped++;
    for (const target of targets) migrated[target] = { ...raw[key], ...migrated[target] };
  }
  saveTranslationMemory(file, migrated, readOwners((raw as Record<string, unknown>).$owners));
  return `${file}: converted ${old.length - dropped} entr${old.length - dropped === 1 ? 'y' : 'ies'}, dropped ${dropped} whose string is in none of the inputs`;
}

/**
 * Converts the v2 hash sidecars and translation-memory files of the named inputs to v3.
 * A file that is already v3 is left alone, so running it again changes nothing.
 */
export function runMigrate(tokens: string[], stdout: NodeJS.WritableStream): void {
  const args = parseMigrateArgs(tokens);
  if (args.help) {
    stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (args.inputs.length === 0) {
    throw new LoquiError('INVALID_USAGE', 'loqui migrate needs at least one input: --input <file>, repeatable.');
  }
  const config = resolveConfig(args.config ?? undefined, undefined);
  // v2 memory did not record the language it was translated from; a v3 key does.
  const from = args.from ?? config.from;
  if (!from) {
    throw new LoquiError('INVALID_USAGE', 'loqui migrate needs --from <locale>, or a `from` in the config.');
  }
  if (!args.to && !config.to) {
    throw new LoquiError('INVALID_USAGE', 'loqui migrate needs --to <locales>, or a `to` in the config.');
  }
  const to = resolveTargets(args.to ?? undefined, config);

  const inputs = args.inputs.map((input) => {
    const { inputPath, sourceFlat } = loadSource(input, config);
    return { inputPath, sourceFlat };
  });

  for (const [file, group] of groupBy(inputs, (input) =>
    sidecarPath(input.inputPath, args.hashFile ?? undefined, 'hash'),
  )) {
    stdout.write(`${migrateSidecar(file, group, to)}\n`);
  }
  for (const [file, group] of groupBy(inputs, (input) =>
    sidecarPath(input.inputPath, args.translationMemoryFile ?? undefined, 'tm'),
  )) {
    stdout.write(`${migrateMemory(file, group, from)}\n`);
  }
}
