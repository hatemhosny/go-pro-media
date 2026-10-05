import http from 'node:http';
import https from 'node:https';

export function httpGet(url, { headers = {}, idleTimeoutMs = 60000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('https:') ? https : http;
    let settled = false;

    const req = lib.get(url, { headers }, (res) => {
      const { statusCode, headers: resHeaders } = res;

      if (statusCode >= 300 && statusCode < 400 && resHeaders.location && redirects > 0) {
        res.resume();
        const next = new URL(resHeaders.location, url).toString();
        httpGet(next, { headers, idleTimeoutMs, redirects: redirects - 1 }).then(resolve, reject);
        settled = true;
        return;
      }

      settled = true;
      resolve({ req, res });
    });

    req.setTimeout(idleTimeoutMs, () => {
      req.destroy(new Error(`Stalled: no data for ${Math.round(idleTimeoutMs / 1000)}s`));
    });

    req.on('error', (err) => {
      if (!settled) reject(err);
    });
  });
}
