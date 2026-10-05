import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseListing, parseSize } from '../src/listing.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/listing.html', import.meta.url));
const baseUrl = 'http://10.5.5.9/videos/DCIM/100GOPRO/';

test('parseSize converts GoPro size labels to bytes', () => {
  assert.equal(parseSize('318.0M'), Math.round(318.0 * 1024 ** 2));
  assert.equal(parseSize('3.7G'), Math.round(3.7 * 1024 ** 3));
  assert.equal(parseSize('1.5T'), Math.round(1.5 * 1024 ** 4));
  assert.equal(parseSize('-'), null);
  assert.equal(parseSize(''), null);
});

test('parseListing reads every file and skips header/parent rows', async () => {
  const html = await fsp.readFile(fixturePath, 'utf8');
  const files = parseListing(html, baseUrl);

  assert.equal(files.length, 10);
  assert.equal(files.filter((f) => f.name.endsWith('.MP4')).length, 5);
  assert.equal(files.filter((f) => f.name.endsWith('.LRV')).length, 5);
  assert.ok(!files.some((f) => f.name === 'Name' || f.name === 'Parent directory'));

  const first = files[0];
  assert.equal(first.name, 'GL010004.LRV');
  assert.equal(first.url, 'http://10.5.5.9/videos/DCIM/100GOPRO/GL010004.LRV');
  assert.equal(first.size, Math.round(318.0 * 1024 ** 2));
});

test('parseListing resolves relative hrefs against the base URL', () => {
  const html = '<table><tr><td><a href="CLIP.MP4">CLIP.MP4</a></td><td>x</td><td>10M</td></tr></table>';
  const files = parseListing(html, 'http://10.5.5.9/gopro/media/list/');
  assert.equal(files[0].url, 'http://10.5.5.9/gopro/media/list/CLIP.MP4');
});
