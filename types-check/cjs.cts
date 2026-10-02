// The same through `require`, which TypeScript resolves under the `require` condition.
import loqui = require('@mihairo/loqui');

const run: (...args: never[]) => Promise<Record<string, string>> = loqui.translate;
const partial: Record<string, string> | undefined = new loqui.LoquiError('CHUNK_FAILED', 'x').partial;

// @ts-expect-error translate is a function
const notAString: string = loqui.translate;
// @ts-expect-error './cli' is not exported
import type {} from '@mihairo/loqui/cli';

export = { notAString, partial, run };
