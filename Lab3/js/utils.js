/* =========================================================
   utils.js — money, formatting, GSTIN rules, small helpers
   Loaded first; everything hangs off the global `GST` namespace
   so the app also runs when index.html is opened via file://
   (ES modules are blocked on file:// in Chrome).
   ========================================================= */
window.GST = window.GST || {};

(function (GST) {
  'use strict';

  /* ---------- Money: all amounts are stored as integer paise ----------
     0.1 + 0.2 !== 0.3 in floating point. Storing ₹ as paise (integers)
     keeps every tax split exact, and rounding happens in exactly one place. */
  const toPaise = (rupees) => Math.round(Number(rupees) * 100);
  const fromPaise = (paise) => paise / 100;

  const inrFormatter = new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const inrShort = new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  });
  const money = (paise) => inrFormatter.format(fromPaise(paise));
  const moneyShort = (paise) => inrShort.format(Math.round(fromPaise(paise)));

  /** Compact Indian notation: ₹1.2 L, ₹3.4 Cr */
  function moneyCompact(paise) {
    const r = fromPaise(paise);
    if (Math.abs(r) >= 1e7) return '₹' + (r / 1e7).toFixed(2) + ' Cr';
    if (Math.abs(r) >= 1e5) return '₹' + (r / 1e5).toFixed(2) + ' L';
    if (Math.abs(r) >= 1e3) return '₹' + (r / 1e3).toFixed(1) + 'k';
    return inrShort.format(Math.round(r));
  }

  /* ---------- Dates ---------- */
  const dateFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const monthFmt = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit' });
  const fmtDate = (iso) => dateFmt.format(new Date(iso));
  const monthKey = (iso) => iso.slice(0, 7); // "2026-11"
  const fmtMonth = (key) => monthFmt.format(new Date(key + '-01T00:00:00'));
  const todayISO = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  /** Indian financial year label for a date: Apr–Mar, e.g. "2026-27" */
  function financialYear(iso) {
    const d = new Date(iso);
    const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
  }

  /* ---------- Indian states & UT GST codes (first 2 digits of a GSTIN) ---------- */
  const STATES = new Map([
    ['01', 'Jammu & Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'],
    ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'],
    ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'],
    ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'],
    ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'],
    ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'],
    ['26', 'Dadra & Nagar Haveli and Daman & Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'],
    ['30', 'Goa'], ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'],
    ['34', 'Puducherry'], ['35', 'Andaman & Nicobar Islands'], ['36', 'Telangana'],
    ['37', 'Andhra Pradesh'], ['38', 'Ladakh'],
  ]);

  /** Valid GST rate slabs (%). A Set gives O(1) membership checks.
      GST 2.0 (effective 22 Sep 2025) moved most goods to 5% / 18%, with 40% for
      sin/luxury goods. 12% and 28% are kept only so older invoices stay valid;
      Invoice Guard warns if a new bill still uses them. */
  const GST_SLABS = new Set([0, 0.25, 3, 5, 12, 18, 28, 40]);
  const CURRENT_SLABS = new Set([0, 0.25, 3, 5, 18, 40]);
  const GST2_EFFECTIVE = '2025-09-22';

  /* ---------- GSTIN validation ----------
     Format: 2-digit state code + 10-char PAN + entity number + 'Z' + check char.
     The last character is a base-36 checksum over the first 14, so a regex
     alone accepts many typos that the checksum catches. */
  const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function gstinCheckChar(first14) {
    let sum = 0;
    for (let i = 0; i < 14; i++) {
      const product = B36.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
      sum += Math.floor(product / 36) + (product % 36);
    }
    return B36[(36 - (sum % 36)) % 36];
  }

  /**
   * Validate a GSTIN offline.
   * @returns {{ok:boolean, reason?:string, stateCode?:string, state?:string, pan?:string}}
   */
  function validateGSTIN(raw) {
    const g = String(raw || '').trim().toUpperCase();
    if (!g) return { ok: false, reason: 'GSTIN is empty' };
    if (g.length !== 15) return { ok: false, reason: `GSTIN must be 15 characters (got ${g.length})` };
    if (!GSTIN_RE.test(g)) return { ok: false, reason: 'GSTIN format is invalid (expected 22AAAAA0000A1Z5 pattern)' };
    const stateCode = g.slice(0, 2);
    if (!STATES.has(stateCode)) return { ok: false, reason: `Unknown state code "${stateCode}"` };
    const expected = gstinCheckChar(g.slice(0, 14));
    if (g[14] !== expected) return { ok: false, reason: `Checksum failed: last character should be "${expected}". Check for a typo.` };
    return { ok: true, gstin: g, stateCode, state: STATES.get(stateCode), pan: g.slice(2, 12) };
  }

  /* ---------- Amount in words (Indian system: lakh / crore) ---------- */
  const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function twoDigits(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''); }
  function threeDigits(n) {
    const h = Math.floor(n / 100), r = n % 100;
    return (h ? ONES[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? twoDigits(r) : '');
  }
  function intToWords(n) {
    if (n === 0) return 'Zero';
    const parts = [];
    const crore = Math.floor(n / 1e7); n %= 1e7;
    const lakh = Math.floor(n / 1e5); n %= 1e5;
    const thousand = Math.floor(n / 1e3); n %= 1e3;
    if (crore) parts.push(intToWords(crore) + ' Crore');
    if (lakh) parts.push(twoDigits(lakh) + ' Lakh');
    if (thousand) parts.push(twoDigits(thousand) + ' Thousand');
    if (n) parts.push(threeDigits(n));
    return parts.join(' ');
  }
  function amountInWords(paise) {
    const rupees = Math.floor(paise / 100), p = paise % 100;
    return 'Rupees ' + intToWords(rupees) + (p ? ' and ' + twoDigits(p) + ' Paise' : '') + ' Only';
  }

  /* ---------- Small helpers ---------- */
  const uid = (prefix) => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function debounce(fn, ms) {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });

  /** Escape user-supplied text before inserting it as HTML (prevents XSS). */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Group an array into a Map keyed by keyFn(item). */
  function groupBy(arr, keyFn) {
    const m = new Map();
    for (const item of arr) {
      const k = keyFn(item);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(item);
    }
    return m;
  }

  Object.assign(GST, {
    toPaise, fromPaise, money, moneyShort, moneyCompact,
    fmtDate, fmtMonth, monthKey, todayISO, financialYear,
    STATES, GST_SLABS, CURRENT_SLABS, GST2_EFFECTIVE, validateGSTIN, gstinCheckChar, amountInWords,
    uid, debounce, sleep, esc, groupBy,
  });
})(window.GST);
