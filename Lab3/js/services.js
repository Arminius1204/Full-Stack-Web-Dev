/* =========================================================
   services.js — everything asynchronous
   1. loadHsnMaster()  — fetch() the HSN→rate list with a timeout,
                          fall back to an embedded copy on failure
   2. verifyGSTIN()    — call a (simulated) GST portal: offline checksum
                          first, then timeout + retry with backoff +
                          cancellation + response cache + in-flight dedupe
   3. readBackupFile() — read and parse a JSON backup without blocking
   ========================================================= */
(function (GST) {
  'use strict';
  const { sleep, validateGSTIN } = GST;

  /* ---------- network activity log (shown in Settings for evaluation) ---------- */
  const log = [];
  const logEvent = (kind, message) => {
    log.unshift({ at: new Date(), kind, message });
    if (log.length > 30) log.pop();
    document.dispatchEvent(new CustomEvent('net-log'));
  };

  /** Settings flag the user can flip to force failures and watch the recovery paths. */
  const net = { simulateOutage: false };

  class NetworkError extends Error {
    constructor(message, { retryable = true, code = 'NETWORK' } = {}) {
      super(message);
      this.name = 'NetworkError';
      this.retryable = retryable;
      this.code = code;
    }
  }

  /** Race a promise against a timer; abort the underlying work if the timer wins. */
  async function withTimeout(task, ms, outerSignal) {
    if (outerSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort(outerSignal.reason);
    outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(new NetworkError(`Timed out after ${ms / 1000}s`, { code: 'TIMEOUT' })), ms);
    try {
      return await task(ctrl.signal);
    } catch (err) {
      if (ctrl.signal.aborted && ctrl.signal.reason instanceof NetworkError) throw ctrl.signal.reason;
      throw err;
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    }
  }

  /** Retry transient failures with exponential backoff + jitter. Never retries a user cancel. */
  async function withRetry(task, { retries = 2, baseDelay = 400, signal, onRetry } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await task(attempt);
      } catch (err) {
        const cancelled = err.name === 'AbortError' || signal?.aborted;
        if (cancelled || err.retryable === false || attempt >= retries) throw err;
        const wait = baseDelay * 2 ** attempt + Math.random() * 150;
        onRetry?.(attempt + 1, err, wait);
        await sleep(wait, signal);
      }
    }
  }

  /* ======================= 1. HSN master ======================= */
  // Embedded copy: used when fetch() is unavailable (index.html opened via file://) or fails.
  const HSN_FALLBACK = [
    ['0401', 'Milk and cream', 0], ['0405', 'Butter, ghee', 5], ['0713', 'Pulses (dal)', 5],
    ['0902', 'Tea', 5], ['1006', 'Rice', 5], ['1101', 'Wheat flour (atta)', 5],
    ['1512', 'Sunflower oil', 5], ['1701', 'Sugar', 5], ['1905', 'Biscuits, bread', 5],
    ['2202', 'Aerated beverages', 40], ['3306', 'Toothpaste', 5], ['3401', 'Soap', 5],
    ['3402', 'Detergents', 18], ['4820', 'Notebooks', 0], ['8414', 'Fans', 18],
    ['8536', 'Switches, sockets', 18], ['8539', 'LED lamps', 18], ['8544', 'Insulated wire', 18],
  ];

  async function loadHsnMaster() {
    const toMap = (items) => new Map(items.map((i) => [i.hsn, { description: i.description, rate: i.rate }]));
    try {
      if (net.simulateOutage) throw new NetworkError('Simulated outage');
      const data = await withTimeout(async (signal) => {
        const res = await fetch('data/hsn-rates.json', { signal, cache: 'no-cache' });
        if (!res.ok) throw new NetworkError(`HTTP ${res.status}`);
        return res.json();
      }, 4000);
      if (!Array.isArray(data.items)) throw new Error('HSN file has no items list');
      logEvent('ok', `HSN master loaded: ${data.items.length} codes`);
      return { source: 'network', map: toMap(data.items) };
    } catch (err) {
      logEvent('warn', `HSN master unavailable (${err.message}); using built-in list`);
      return { source: 'fallback', map: toMap(HSN_FALLBACK.map(([hsn, description, rate]) => ({ hsn, description, rate }))) };
    }
  }

  /* ======================= 2. GSTIN verification ======================= */
  // A stand-in for the government GSTIN search API (which needs GSP credentials).
  // It behaves like a real remote service: variable latency, occasional 503s,
  // occasional hangs, and records that may be cancelled or suspended.
  const REGISTRY = new Map([
    ['29ABCDE1234F1ZW', { legalName: 'Sharma General & Electricals', status: 'Active', type: 'Regular' }],
    ['29AAGCM4821K1Z6', { legalName: 'Maruthi Electricals', status: 'Active', type: 'Regular' }],
    ['29BXHPS7712Q1ZG', { legalName: 'Srinidhi Caterers', status: 'Active', type: 'Composition' }],
    ['27AACCT5531R1ZS', { legalName: 'Techno Build Private Limited', status: 'Active', type: 'Regular' }],
    ['33AAFFK9087L1ZS', { legalName: 'Kaveri Traders', status: 'Active', type: 'Regular' }],
    ['29AAKFN6345D1Z3', { legalName: 'Nandi Hostel Mess', status: 'Active', type: 'Regular' }],
    ['29AJXPR2290M1Z3', { legalName: 'R. Prakash Enterprises', status: 'Cancelled', type: 'Regular' }],
    ['07AABCU9603R1ZP', { legalName: 'Urban Mart Delhi LLP', status: 'Suspended', type: 'Regular' }],
  ]);

  async function mockPortal(gstin, signal) {
    const latency = 500 + Math.random() * 1100;
    const roll = Math.random();
    if (net.simulateOutage || roll < 0.12) {
      await sleep(latency / 2, signal);
      throw new NetworkError('GST portal returned 503 Service Unavailable', { code: 'HTTP_503' });
    }
    if (roll < 0.17) await sleep(10000, signal); // a hung request: only the timeout rescues it
    await sleep(latency, signal);
    const rec = REGISTRY.get(gstin);
    if (rec) return { gstin, ...rec };
    // Unknown but checksum-valid GSTINs: treat as an active regular taxpayer.
    return { gstin, legalName: null, status: 'Active', type: 'Regular' };
  }

  const cache = new Map();    // gstin -> { result, at }
  const inFlight = new Map(); // gstin -> Promise (two callers share one request)
  const CACHE_TTL = 10 * 60 * 1000;

  /**
   * @param {string} raw GSTIN as typed
   * @param {{signal?:AbortSignal, onRetry?:Function}} opts
   * @returns {Promise<{gstin,legalName,status,type,state,fromCache?:boolean}>}
   */
  async function verifyGSTIN(raw, { signal, onRetry } = {}) {
    const offline = validateGSTIN(raw);
    if (!offline.ok) throw new NetworkError(offline.reason, { retryable: false, code: 'INVALID' });
    const gstin = offline.gstin;

    const hit = cache.get(gstin);
    if (hit && Date.now() - hit.at < CACHE_TTL) {
      logEvent('ok', `GSTIN ${gstin}: served from cache`);
      return { ...hit.result, fromCache: true };
    }
    if (inFlight.has(gstin)) return inFlight.get(gstin);

    const started = performance.now();
    const p = withRetry(
      (attempt) => withTimeout((s) => mockPortal(gstin, s), 3000, signal).then((r) => {
        logEvent('ok', `GSTIN ${gstin}: ${r.status} (attempt ${attempt + 1}, ${Math.round(performance.now() - started)} ms)`);
        return r;
      }),
      {
        retries: 2, signal,
        onRetry: (n, err, wait) => {
          logEvent('warn', `GSTIN ${gstin}: ${err.message}, retry ${n} in ${Math.round(wait)} ms`);
          onRetry?.(n, err);
        },
      },
    ).then((r) => {
      const result = { ...r, state: offline.state };
      cache.set(gstin, { result, at: Date.now() });
      return result;
    }).catch((err) => {
      if (err.name === 'AbortError') logEvent('info', `GSTIN ${gstin}: request cancelled (input changed)`);
      else logEvent('err', `GSTIN ${gstin}: gave up — ${err.message}`);
      throw err;
    }).finally(() => inFlight.delete(gstin));

    inFlight.set(gstin, p);
    return p;
  }

  /* ======================= 3. Backup file ======================= */
  async function readBackupFile(file) {
    if (!file) throw new Error('No file selected');
    if (!/\.json$/i.test(file.name)) throw new Error('Choose a .json backup file');
    if (file.size > 5 * 1024 * 1024) throw new Error('Backup is larger than 5 MB');
    const text = await file.text();
    try { return JSON.parse(text); }
    catch { throw new Error('File is not valid JSON'); }
  }

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCSV(rows, filename) {
    const csv = rows.map((r) => r.map((v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  Object.assign(GST, { net, netLog: log, NetworkError, withTimeout, withRetry, loadHsnMaster, verifyGSTIN, readBackupFile, downloadJSON, downloadCSV });
})(window.GST);
