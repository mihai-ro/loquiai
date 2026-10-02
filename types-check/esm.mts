// Resolves the package by its own name through `exports`, the way a consumer's
// TypeScript does, so a broken `types` condition shows up here.
import { LoquiError, translate } from '@mihairo/loqui';

const run: (...args: never[]) => Promise<Record<string, string>> = translate;
const partial: Record<string, string> | undefined = new LoquiError('CHUNK_FAILED', 'x').partial;

// Controls, so this cannot pass by resolving to `any`: translate is not a string, and
// the CLI is not an export. An unused directive here is an error.
// @ts-expect-error translate is a function
const notAString: string = translate;
// @ts-expect-error './cli' is not exported
import type {} from '@mihairo/loqui/cli';

export { notAString, partial, run };
