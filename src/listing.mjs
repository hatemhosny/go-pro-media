import { httpGet } from './http.mjs';

const SIZE_UNITS = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const isHex = code[1] === 'x' || code[1] === 'X';
      const value = parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10);
      return Number.isNaN(value) ? match : String.fromCodePoint(value);
    }
    const named = ENTITIES[code.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

export function parseSize(raw) {
  if (raw == null) return null;
  const text = decodeEntities(String(raw)).replace(/<[^>]*>/g, '').trim();
  const match = /^([\d.]+)\s*([KMGT])$/i.exec(text);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * SIZE_UNITS[match[2].toUpperCase()]);
}

export function parseListing(html, baseUrl) {
  const files = [];
  const rows = String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);

  for (const [, row] of rows) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length === 0) continue;

    const link = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!link) continue;

    const href = link[1];
    const name = decodeEntities(link[2]).trim();

    if (!href || href.endsWith('/..') || href.endsWith('/') || /^parent directory$/i.test(name)) {
      continue;
    }

    const sizeText = cells.length >= 3 ? decodeEntities(cells[2]).replace(/<[^>]*>/g, '').trim() : '';

    let url;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    files.push({ name, url, size: parseSize(cells[2]), sizeText });
  }

  return files;
}

export async function fetchListing(url, { timeoutMs = 20000 } = {}) {
  const { res } = await httpGet(url, { idleTimeoutMs: timeoutMs });

  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`Could not list ${url}: HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim());
  }

  res.setEncoding('utf8');
  let body = '';
  for await (const chunk of res) body += chunk;

  const files = parseListing(body, url);
  if (files.length === 0) {
    throw new Error(`No files found at ${url}. Check that the camera is connected and the path is correct.`);
  }
  return files;
}
