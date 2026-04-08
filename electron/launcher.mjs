/**
 * Electron ESM launcher — registers tsx for TypeScript support,
 * then dynamically imports the main process.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('tsx/esm', pathToFileURL('./'));

const { default: main } = await import('./main.ts');
