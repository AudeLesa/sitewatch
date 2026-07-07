// Small fetch wrappers: timeout + retry with backoff, and a concurrency limiter.

export async function fetchWithRetry(url, opts = {}, { retries = 3, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(t);
      if (res.status >= 500 || res.status === 429) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (attempt < retries) {
        await sleep(300 * 2 ** attempt);
      }
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts, retryOpts) {
  const res = await fetchWithRetry(url, opts, retryOpts);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

export async function fetchText(url, opts, retryOpts) {
  const res = await fetchWithRetry(url, opts, retryOpts);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run async `fn` over `items` with bounded concurrency, preserving order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
