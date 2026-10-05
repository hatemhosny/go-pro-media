import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { httpGet } from './http.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fileSize(filePath) {
  try {
    return (await fsp.stat(filePath)).size;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

async function replaceFile(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'EPERM') {
      await fsp.rm(dest, { force: true });
      await fsp.rename(src, dest);
    } else {
      throw err;
    }
  }
}

export async function downloadFile({
  url,
  destPath,
  expectedTotal = null,
  onProgress,
  onEvent,
  retries = 6,
  retryDelayMs = 1000,
  maxRetryDelayMs = 30000,
  idleTimeoutMs = 60000,
}) {
  const partPath = `${destPath}.part`;
  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await attemptDownload({
        url,
        partPath,
        destPath,
        expectedTotal,
        onProgress,
        idleTimeoutMs,
      });
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      const delay = Math.min(retryDelayMs * 2 ** (attempt - 1), maxRetryDelayMs);
      onEvent?.({ type: 'retry', attempt, delayMs: delay, message: err.message });
      await sleep(delay);
    }
  }
  throw new Error(`${lastError && lastError.message ? lastError.message : lastError} (gave up after ${retries} attempts)`);
}

async function attemptDownload({ url, partPath, destPath, expectedTotal, onProgress, idleTimeoutMs }) {
  const resumeFrom = await fileSize(partPath);

  const headers = {};
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

  const { res } = await httpGet(url, { headers, idleTimeoutMs });
  const status = res.statusCode;

  // 416 means our partial file already covers the whole resource (crash after the
  // last byte was written but before the rename). Treat it as complete.
  if (status === 416 && resumeFrom > 0) {
    res.resume();
    await replaceFile(partPath, destPath);
    return { status: 'done', total: resumeFrom, resumedFrom: resumeFrom };
  }

  let start = resumeFrom;
  if (status === 200 && resumeFrom > 0) {
    // Server ignored the Range header, so the partial file is useless: start over.
    start = 0;
  }

  if (status !== 200 && status !== 206) {
    res.resume();
    throw new Error(`HTTP ${status} ${res.statusMessage || ''}`.trim());
  }

  let authoritativeTotal = null;
  if (status === 206) {
    const match = /\/(\d+)\s*$/.exec(res.headers['content-range'] || '');
    if (match) authoritativeTotal = Number.parseInt(match[1], 10);
  } else {
    const length = res.headers['content-length'];
    if (length != null) authoritativeTotal = start + Number.parseInt(length, 10);
  }

  const total = authoritativeTotal ?? expectedTotal ?? 0;
  let received = 0;

  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      onProgress?.({ downloaded: start + received, total });
      callback(null, chunk);
    },
  });

  const writeStream = fs.createWriteStream(partPath, { flags: start > 0 ? 'a' : 'w' });
  const writeClosed = once(writeStream, 'close');

  try {
    await pipeline(res, counter, writeStream);
  } catch (err) {
    await writeClosed;
    throw err;
  }
  await writeClosed;

  const finalSize = await fileSize(partPath);
  if (authoritativeTotal != null && finalSize !== authoritativeTotal) {
    throw new Error(`Incomplete file: got ${finalSize} of ${authoritativeTotal} bytes`);
  }

  await replaceFile(partPath, destPath);
  return { status: 'done', total: finalSize, resumedFrom: start };
}

export async function runPool(items, worker, concurrency) {
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, runner);
  await Promise.all(runners);
}
