/**
 * Electron launcher — registers tsx for TypeScript support,
 * then loads the main process.
 */
require('tsx/cjs');
require('./main.ts');
