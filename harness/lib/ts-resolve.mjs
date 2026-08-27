// Module resolver hook for the runner's TypeScript imports (registered from run.mjs before the dynamic imports).
// Node strips types but does not add extensions: a value import like `import { x } from '../protocol'` inside
// extension/src resolves only in Vite. For an extension-less relative specifier try `<spec>.ts`, then `<spec>/index.ts`.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
    const base = new URL(specifier, context.parentURL).href;
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
      if (existsSync(fileURLToPath(candidate))) return next(candidate, context);
    }
  }
  return next(specifier, context);
}
