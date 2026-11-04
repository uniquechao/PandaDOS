/** Test fixtures under a managed TMPDIR must not discover the enclosing project repository. */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';

const temporaryRoot = resolve(tmpdir());
const ceilings = new Set((process.env.GIT_CEILING_DIRECTORIES ?? '').split(delimiter).filter(Boolean));
ceilings.add(temporaryRoot);
try { ceilings.add(realpathSync(temporaryRoot)); } catch { /* The fixture will report an unusable TMPDIR. */ }
process.env.GIT_CEILING_DIRECTORIES = [...ceilings].join(delimiter);
