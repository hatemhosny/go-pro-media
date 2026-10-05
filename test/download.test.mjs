import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { downloadFile } from '../src/download.mjs';

function makeBuffer(length) {
  const buffer = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) buffer[i] = i % 251;
  return buffer;
}

async function startServer(content, { breakFirstRequest = false } = {}) {
  const state = { requests: 0, ranges: [] };

  const server = http.createServer((req, res) => {
    state.requests++;
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = content.length - 1;

    if (rangeHeader) {
      const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      start = Number.parseInt(match[1], 10);
      if (match[2]) end = Number.parseInt(match[2], 10);
      if (start >= content.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${content.length}` });
        res.end();
        return;
      }
    }

    const status = rangeHeader ? 206 : 200;
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${content.length}`;
    res.writeHead(status, headers);
    state.ranges.push([start, end]);

    if (breakFirstRequest && state.requests === 1) {
      const cut = Math.floor((end - start + 1) / 2);
      res.write(content.subarray(start, start + cut));
      setTimeout(() => res.destroy(), 30);
      return;
    }

    res.end(content.subarray(start, end + 1));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/clip.MP4`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gopro-dl-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('downloads a file completely and renames it into place', async (t) => {
  const content = makeBuffer(400_000);
  const server = await startServer(content);
  t.after(() => server.close());

  const dir = await tempDir(t);
  const dest = path.join(dir, 'clip.MP4');

  const result = await downloadFile({ url: server.url, destPath: dest, retries: 3, retryDelayMs: 5 });

  assert.equal(result.status, 'done');
  assert.deepEqual(await fsp.readFile(dest), content);
  await assert.rejects(fsp.stat(`${dest}.part`), { code: 'ENOENT' });
});

test('resumes from an existing .part file using a Range request', async (t) => {
  const content = makeBuffer(400_000);
  const half = 150_000;
  const server = await startServer(content);
  t.after(() => server.close());

  const dir = await tempDir(t);
  const dest = path.join(dir, 'clip.MP4');
  await fsp.writeFile(`${dest}.part`, content.subarray(0, half));

  const result = await downloadFile({ url: server.url, destPath: dest, retries: 3, retryDelayMs: 5 });

  assert.equal(result.resumedFrom, half);
  assert.deepEqual(server.state.ranges[0], [half, content.length - 1]);
  assert.deepEqual(await fsp.readFile(dest), content);
});

test('retries and resumes after a dropped connection', async (t) => {
  const content = makeBuffer(2_000_000);
  const server = await startServer(content, { breakFirstRequest: true });
  t.after(() => server.close());

  const dir = await tempDir(t);
  const dest = path.join(dir, 'clip.MP4');

  await downloadFile({ url: server.url, destPath: dest, retries: 5, retryDelayMs: 10 });

  assert.ok(server.state.requests >= 2, `expected a retry, saw ${server.state.requests} request(s)`);
  assert.deepEqual(await fsp.readFile(dest), content);
  await assert.rejects(fsp.stat(`${dest}.part`), { code: 'ENOENT' });
});

test('treats HTTP 416 as an already-complete partial file', async (t) => {
  const content = makeBuffer(50_000);
  const server = await startServer(content);
  t.after(() => server.close());

  const dir = await tempDir(t);
  const dest = path.join(dir, 'clip.MP4');
  await fsp.writeFile(`${dest}.part`, content);

  const result = await downloadFile({ url: server.url, destPath: dest, retries: 2, retryDelayMs: 5 });

  assert.equal(result.status, 'done');
  assert.equal(server.state.requests, 1);
  assert.deepEqual(await fsp.readFile(dest), content);
  await assert.rejects(fsp.stat(`${dest}.part`), { code: 'ENOENT' });
});
