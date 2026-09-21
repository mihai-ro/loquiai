#!/usr/bin/env node

// No "am I the main module" guard here: npm installs `bin` as a symlink, so
// process.argv[1] is the symlink path while import.meta.url is the realpath —
// they never match and the CLI silently does nothing. This file is reachable
// only as the `bin` or the `./cli` export, and both mean "run the CLI", so the
// whole implementation lives in ./cli.ts and this entry just calls it.
import { run } from './cli.js';

run();
