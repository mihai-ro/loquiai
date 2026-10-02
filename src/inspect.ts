import { type DiffResult, diffLocales } from './diff.js';
import { loadHashStore } from './hasher.js';
import {
  loadExisting,
  loadSource,
  type OutputOption,
  resolveConfig,
  resolveOutputPaths,
  resolveTargets,
  sidecarPath,
  stringsOf,
} from './project.js';
import type { LoquiConfig } from './types.js';
import { type ValidationResult, validateLocales } from './validate.js';

export interface InspectOptions {
  /** Source to compare against. Either a file path or a raw JSON string. */
  input: string;
  /** Target locale(s). Overrides config.to. */
  to?: string | string[];
  /**
   * The target files to inspect.
   * - string: path template with `{locale}`, or a directory
   * - Record: explicit path per locale
   */
  output: OutputOption;
  /** Explicit path for the hash sidecar `diff()` reads. Defaults to the one next to the input. */
  hashFile?: string;
  /** Inline config merged over any config file found. */
  config?: Partial<LoquiConfig>;
  /** Path to a config file or a directory containing one. Defaults to process.cwd(). */
  configPath?: string;
}

export interface DiffReport {
  results: DiffResult[];
  /**
   * Whether a hash sidecar was found. Without one nothing can be reported as `changed`,
   * so a `false` here is the caller's cue to say so.
   */
  hasBaseline: boolean;
}

/** What the files `inspect` reads say about the source: the locales to compare, and the target files. */
function load(options: InspectOptions) {
  const config = resolveConfig(options.configPath, options.config);
  const to = resolveTargets(options.to, config);
  const { inputPath, sourceFlat } = loadSource(options.input, config);
  const existing = loadExisting(resolveOutputPaths(options.output, to), to);
  return { inputPath, sourceFlat, existing: stringsOf(existing) };
}

/**
 * Compares the source with the target files on disk: which keys they lack, which they
 * hold that the source no longer has, and which changed in the source since the hash
 * sidecar was written. Only reads: no log, no file written, no exit code set.
 */
export function diff(options: InspectOptions): DiffReport {
  const { inputPath, sourceFlat, existing } = load(options);
  const hashFilePath = sidecarPath(inputPath, options.hashFile, 'hash');
  const hashStore = hashFilePath ? loadHashStore(hashFilePath) : {};
  return {
    results: diffLocales(sourceFlat, existing, hashStore),
    hasBaseline: Object.keys(hashStore).length > 0,
  };
}

/**
 * Checks that each target file holds exactly the source's keys. A locale with no file is
 * absent from the result. Only reads: the caller decides what a mismatch means.
 */
export function validate(options: InspectOptions): ValidationResult[] {
  const { sourceFlat, existing } = load(options);
  return validateLocales(sourceFlat, existing);
}
