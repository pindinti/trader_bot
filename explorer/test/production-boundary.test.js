import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

test('Vite cannot copy local candle staging into the production build', async () => {
  const config = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
  const rootIgnore = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');
  const exporter = await readFile(new URL('../../scripts/export_explorer.py', import.meta.url), 'utf8');
  assert.match(config, /publicDir:\s*false/);
  assert.match(rootIgnore, /data\/explorer_storage\//);
  assert.match(exporter, /data" \/ "explorer_storage"/);
  assert.doesNotMatch(exporter, /explorer" \/ "public" \/ "data"/);

  const publicDirectory = new URL('../public/', import.meta.url);
  const publicFiles = await readdir(publicDirectory, { recursive: true });
  assert.equal(publicFiles.some((path) => /(?:^|[\\/])manifest\.json$/.test(path)), false);
  assert.equal(publicFiles.some((path) => /WDOV26[\\/].+\.json$/.test(path)), false);
});
