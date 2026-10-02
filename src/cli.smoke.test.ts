import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * These tests run the BUILT artifacts, not the TypeScript sources — the bugs they
 * guard against (a duplicated shebang, an entry guard that fails under a symlink)
 * only exist after bundling, so testing the sources would pass with the bug present.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distEsm = path.join(repoRoot, 'dist', 'index.js');
const ANSI_PREFIX = '\u001b[';

let tmpDir: string;
/** npm installs `bin` as a symlink; running through one is the whole point of these tests. */
let binLink: string;

before(async () => {
  // Build here rather than relying on a prior `pnpm build`: the artifact under test
  // must match the sources in this tree, and a missing dist would otherwise make
  // these tests silently vacuous.
  const build = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build.mjs')], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  assert.equal(build.status, 0, `build failed:\n${build.stderr}`);

  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loqui-smoke-'));
  binLink = path.join(tmpDir, 'loqui');
  await fs.promises.symlink(distEsm, binLink);
});

after(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('built CLI — ESM entry through a symlink', () => {
  test('--help prints usage and exits 0', () => {
    const result = spawnSync(process.execPath, [binLink, '--help'], { encoding: 'utf-8', cwd: tmpDir });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /loqui — i18n translation CLI/);
    assert.match(result.stdout, /Exit codes:/);
  });

  test('is reached through the symlink, not only by its real path', () => {
    const viaLink = spawnSync(process.execPath, [binLink, '--help'], { encoding: 'utf-8', cwd: tmpDir });
    const viaRealPath = spawnSync(process.execPath, [distEsm, '--help'], { encoding: 'utf-8', cwd: tmpDir });

    assert.equal(viaLink.stdout, viaRealPath.stdout);
    assert.notEqual(viaLink.stdout.trim(), '');
  });

  test('exits with the documented code and a diagnostic when the config is incomplete', () => {
    const result = spawnSync(process.execPath, [binLink, '{"a":"x"}', '--from', 'en'], {
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.equal(result.status, 9);
    assert.match(result.stderr, /target locale/);
    assert.equal(result.stdout, '');
  });
});

describe('built CLI — usage errors exit 11', () => {
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, [binLink, ...args], { encoding: 'utf-8', cwd: tmpDir, input });

  test('a second positional names the token it would drop', () => {
    const result = run(['{"a":"x"}', '--from', 'en', '--to', 'fr', 'de']);

    assert.equal(result.status, 11);
    assert.match(result.stderr, /de/);
    assert.equal(result.stdout, '');
  });

  test('a value flag followed by a flag names the flag', () => {
    const result = run(['{"a":"x"}', '--output', '--incremental']);

    assert.equal(result.status, 11);
    assert.match(result.stderr, /--output/);
  });

  test('empty stdin exits 11', () => {
    const result = run(['--from', 'en', '--to', 'fr'], '');

    assert.equal(result.status, 11);
    assert.match(result.stderr, /empty input/);
  });
});

describe('built package — what its name resolves to', () => {
  // cwd at the repo root: a package resolves itself by name through its own `exports`
  const probe = (script: string) => spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', cwd: repoRoot });

  test("import('@mihairo/loqui') exposes translate", () => {
    const result = probe("import('@mihairo/loqui').then((m) => console.log(typeof m.translate))");

    assert.equal(result.stdout.trim(), 'function', `stderr: ${result.stderr}`);
  });

  test("require('@mihairo/loqui') exposes translate", () => {
    const result = probe("console.log(typeof require('@mihairo/loqui').translate)");

    assert.equal(result.stdout.trim(), 'function', `stderr: ${result.stderr}`);
    // the package is ESM only, so this is the proof that a CommonJS caller still works, quietly
    assert.doesNotMatch(result.stderr, /ExperimentalWarning/);
  });

  test("import('@mihairo/loqui/cli') is not exported, so importing the package can never run the CLI", () => {
    const result = probe("import('@mihairo/loqui/cli').catch((e) => console.log(e.code))");

    assert.equal(result.stdout.trim(), 'ERR_PACKAGE_PATH_NOT_EXPORTED', `stderr: ${result.stderr}`);
  });
});

describe('built CLI — stdout carries results only', () => {
  test('piped stdout is valid JSON while diagnostics go to stderr', () => {
    const result = spawnSync(
      process.execPath,
      [binLink, '{"greeting":{"hi":"Hello"}}', '--from', 'en', '--to', 'fr', '--dry-run'],
      { encoding: 'utf-8', cwd: tmpDir },
    );

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.doesNotThrow(
      () => JSON.parse(result.stdout),
      `stdout was not valid JSON — a diagnostic leaked into it: ${JSON.stringify(result.stdout)}`,
    );
    assert.match(result.stderr, /\[loqui\] i18n translator/);
    // progress comes from the library through the logger the CLI hands it
    assert.match(result.stderr, /Translating 1 key\(s\) → fr/);
  });

  test('two locales on stdout are one JSON document whose values are objects', () => {
    const result = spawnSync(process.execPath, [binLink, '{"a":"x"}', '--from', 'en', '--to', 'es,pt', '--dry-run'], {
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(parsed).sort(), ['es', 'pt']);
    assert.equal(typeof parsed.es, 'object');
    assert.equal(typeof parsed.pt, 'object');
  });

  test('emits no ANSI escapes when stderr is not a TTY', () => {
    const result = spawnSync(process.execPath, [binLink, '{"a":"x"}', '--from', 'en', '--to', 'fr', '--dry-run'], {
      encoding: 'utf-8',
      cwd: tmpDir,
    });

    assert.ok(!result.stderr.includes(ANSI_PREFIX), `stderr carried ANSI escapes: ${JSON.stringify(result.stderr)}`);
  });
});

describe('built CLI — --diff and --validate report on stdout', () => {
  /** A directory with an es.json that lacks `b` and has a stale key. */
  function target(): string {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'report-'));
    fs.writeFileSync(path.join(dir, 'es.json'), JSON.stringify({ a: 'x', stale: 'y' }), 'utf-8');
    return path.join(dir, '{locale}.json');
  }

  test('--validate prints the report on stdout, only diagnostics on stderr, and exits 1 on a mismatch', () => {
    const result = spawnSync(
      process.execPath,
      [binLink, '{"a":"x","b":"y"}', '--to', 'es', '--validate', '--output', target()],
      { encoding: 'utf-8', cwd: tmpDir },
    );

    assert.equal(result.status, 1, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /\[es\]/);
    assert.match(result.stdout, /✗ missing: b/);
    assert.match(result.stdout, /✗ extra: stale/);
    assert.match(result.stdout, /Summary: 1 missing, 1 extra, 1 ok/);
    assert.doesNotMatch(result.stderr, /missing|extra|Summary/);
  });

  test('--validate exits 0 when the target matches', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'report-'));
    fs.writeFileSync(path.join(dir, 'es.json'), JSON.stringify({ a: 'x' }), 'utf-8');

    const result = spawnSync(
      process.execPath,
      [binLink, '{"a":"x"}', '--to', 'es', '--validate', '--output', path.join(dir, '{locale}.json')],
      { encoding: 'utf-8', cwd: tmpDir },
    );

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Summary: 0 missing, 0 extra, 1 ok/);
  });

  test('--diff prints the report on stdout and warns about the missing baseline on stderr', () => {
    const result = spawnSync(
      process.execPath,
      [binLink, '{"a":"x","b":"y"}', '--to', 'es', '--diff', '--output', target()],
      { encoding: 'utf-8', cwd: tmpDir },
    );

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /\[es\]/);
    assert.match(result.stdout, /\+ b/);
    assert.match(result.stdout, /Summary: 1 added, 1 removed, 0 changed, 1 unchanged/);
    assert.match(result.stderr, /No hash sidecar found/);
    assert.doesNotMatch(result.stderr, /Summary/);
  });
});
