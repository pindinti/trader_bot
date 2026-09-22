import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

const forbiddenDataDirectory = new URL('../dist/data/', import.meta.url);

try {
  await access(forbiddenDataDirectory, constants.F_OK);
  throw new Error('Production build contains dist/data; private candle objects must not be shipped by Vite.');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

process.stdout.write('Verified: production build contains no public candle-data directory.\n');
