/* =========================================================
   analytics.js — insights computed from the invoice records
   Most reports are built in ONE pass over the invoices, filling
   several Maps at once, instead of filtering the array once per report.
   Results are memoised per store version, so switching tabs is free.
   ========================================================= */
(function (GST) {
  'use strict';
  const { store, monthKey, todayISO } = GST;

  let version = 0;
  const memo = new Map();
  store.addEventListener('change', () => { version++; memo.clear(); });
  const cached = (key, fn) => {
    const k = key + '@' + version;
    if (!memo.has(k)) memo.set(k, fn());
    return memo.get(k);
  };

  const addDays = (iso, n) => {
    const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);

  /** Valid (non-cancelled) invoices in [from, to], sorted newest first. */
  function invoicesIn(from = '0000-00-00', to = '9999-12-31') {
    return [...store.invoices.values()]
      .filter((i) => !i.cancelled && i.date >= from && i.date <= to)
      .sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
  }

  function pctChange(now, before) {
    if (!before) return now ? null : 0;
    return ((now - before) / before) * 100;
  }

  /** Headline numbers for a window of `days`, compared with the window before it. */
  function kpis(days = 30) {
    return cached('kpis' + days, () => {
      const to = todayISO(), from = addDays(to, -(days - 1));
      const prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(days - 1));
      const sum = (list) => {
        const customers = new Set();
        let sales = 0, tax = 0, taxable = 0;
        for (const i of list) {
          sales += i.totals.grandTotal; tax += i.totals.tax; taxable += i.totals.taxable;
          customers.add(i.customerId || 'walk-in:' + i.id); // every walk-in counts as a distinct visit
        }
        return { sales, tax, taxable, count: list.length, customers: customers.size, avg: list.length ? Math.round(sales / list.length) : 0 };
      };
      const cur = sum(invoicesIn(from, to));
      const prev = sum(invoicesIn(prevFrom, prevTo));
      let receivable = 0, overdue = 0;
      for (const i of store.invoices.values()) {
        if (i.cancelled || i.status !== 'unpaid') continue;
        receivable += i.totals.grandTotal;
        if (daysBetween(i.date, to) > 30) overdue += i.totals.grandTotal;
      }
      return {
        ...cur, receivable, overdue, from, to,
        delta: { sales: pctChange(cur.sales, prev.sales), tax: pctChange(cur.tax, prev.tax), count: pctChange(cur.count, prev.count), avg: pctChange(cur.avg, prev.avg) },
      };
    });
  }

  /** Last n months of sales and GST, oldest first, months with no sales included as 0. */
  function monthlySeries(n = 6) {
    return cached('monthly' + n, () => {
      const months = new Map();
      const d = new Date(todayISO() + 'T00:00:00'); d.setDate(1);
      for (let k = n - 1; k >= 0; k--) {
        const m = new Date(d.getFullYear(), d.getMonth() - k, 1);
        months.set(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`, { sales: 0, tax: 0, count: 0 });
      }
      for (const i of invoicesIn()) {
        const bucket = months.get(monthKey(i.date));
        if (!bucket) continue;
        bucket.sales += i.totals.grandTotal; bucket.tax += i.totals.tax; bucket.count++;
      }
      return [...months].map(([month, v]) => ({ month, ...v }));
    });
  }

  /**
   * One pass over a period's invoices → every report the Reports tab needs:
   * GST by rate slab, HSN summary (GSTR-1 Table 12), B2B by GSTIN,
   * B2C by place of supply + rate, products and customers ranked.
   */
  function periodReport(from, to) {
    return cached(`period:${from}:${to}`, () => {
      const list = invoicesIn(from, to);
      const slabs = new Map(), hsn = new Map(), b2b = new Map(), b2c = new Map(), products = new Map(), customers = new Map();
      const totals = { taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0, sales: 0, invoices: list.length, b2bCount: 0 };
      const bump = (map, key, init) => { if (!map.has(key)) map.set(key, init()); return map.get(key); };

      for (const inv of list) {
        totals.sales += inv.totals.grandTotal; totals.taxable += inv.totals.taxable; totals.tax += inv.totals.tax;
        totals.cgst += inv.totals.cgst; totals.sgst += inv.totals.sgst; totals.igst += inv.totals.igst;
        if (inv.isB2B) {
          totals.b2bCount++;
          const b = bump(b2b, inv.customerGstin, () => ({ gstin: inv.customerGstin, name: inv.customerName, invoices: 0, taxable: 0, tax: 0, total: 0 }));
          b.invoices++; b.taxable += inv.totals.taxable; b.tax += inv.totals.tax; b.total += inv.totals.grandTotal;
        }
        const c = bump(customers, inv.customerId || 'walk-in', () => ({ name: inv.customerId ? inv.customerName : 'Walk-in customers', total: 0, invoices: 0 }));
        c.total += inv.totals.grandTotal; c.invoices++;

        for (const l of inv.computed) {
          const s = bump(slabs, l.rate, () => ({ rate: l.rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 }));
          s.taxable += l.taxable; s.cgst += l.cgst; s.sgst += l.sgst; s.igst += l.igst;
          const h = bump(hsn, l.hsn + '|' + l.rate, () => ({ hsn: l.hsn, rate: l.rate, description: l.name, unit: l.unit, qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 }));
          h.qty += l.qty; h.taxable += l.taxable; h.cgst += l.cgst; h.sgst += l.sgst; h.igst += l.igst;
          if (!inv.isB2B) {
            const k = bump(b2c, inv.placeOfSupply + '|' + l.rate, () => ({ pos: inv.placeOfSupply, rate: l.rate, taxable: 0, tax: 0 }));
            k.taxable += l.taxable; k.tax += l.tax;
          }
          const p = bump(products, l.productId, () => ({ id: l.productId, name: l.name, qty: 0, revenue: 0, unit: l.unit }));
          p.qty += l.qty; p.revenue += l.total;
        }
      }
      const byNum = (k) => (a, b) => b[k] - a[k];
      return {
        totals,
        slabs: [...slabs.values()].sort((a, b) => a.rate - b.rate),
        hsn: [...hsn.values()].sort((a, b) => a.hsn.localeCompare(b.hsn)),
        b2b: [...b2b.values()].sort(byNum('total')),
        b2c: [...b2c.values()].sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate),
        products: [...products.values()].sort(byNum('revenue')),
        customers: [...customers.values()].sort(byNum('total')),
      };
    });
  }

  /** Average sales by weekday over the last 90 days — when is the shop busiest? */
  function weekdayPattern() {
    return cached('weekday', () => {
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const totals = names.map((name) => ({ name, sales: 0, days: new Set() }));
      const to = todayISO(), from = addDays(to, -89);
      for (const i of invoicesIn(from, to)) {
        const t = totals[new Date(i.date + 'T00:00:00').getDay()];
        t.sales += i.totals.grandTotal; t.days.add(i.date);
      }
      // ~13 of each weekday in 90 days; divide by that, not by days-with-sales, so quiet days show as quiet
      return totals.map((t) => ({ name: t.name, avg: Math.round(t.sales / 13) }));
    });
  }

  /**
   * Restock forecast: average daily units sold over the last 30 days,
   * then days of stock left = stock / daily rate. Flags items that will
   * run out within `leadDays` (the time a distributor takes to deliver).
   */
  function restockForecast(leadDays = 7) {
    return cached('restock' + leadDays, () => {
      const to = todayISO(), from = addDays(to, -29);
      const sold = new Map();
      for (const inv of invoicesIn(from, to)) for (const l of inv.lines) sold.set(l.productId, (sold.get(l.productId) || 0) + l.qty);
      return [...store.products.values()].map((p) => {
        const perDay = (sold.get(p.id) || 0) / 30;
        const daysLeft = perDay > 0 ? p.stock / perDay : Infinity;
        const suggested = Math.max(0, Math.ceil(perDay * (leadDays + 14) - p.stock)); // cover lead time + 2 weeks
        const level = p.stock === 0 ? 'out' : daysLeft <= leadDays || p.isLowStock ? 'low' : daysLeft <= leadDays * 2 ? 'watch' : 'ok';
        return { product: p, perDay, daysLeft, suggested, level };
      }).sort((a, b) => a.daysLeft - b.daysLeft);
    });
  }

  /** Customers with unpaid bills, oldest first, with how long each has been pending. */
  function receivables() {
    return cached('receivables', () => {
      const today = todayISO();
      const by = new Map();
      for (const inv of store.invoices.values()) {
        if (inv.cancelled || inv.status !== 'unpaid') continue;
        const key = inv.customerId || inv.customerName;
        if (!by.has(key)) by.set(key, { name: inv.customerName, customerId: inv.customerId, amount: 0, invoices: [], oldestDays: 0 });
        const r = by.get(key);
        r.amount += inv.totals.grandTotal; r.invoices.push(inv);
        r.oldestDays = Math.max(r.oldestDays, daysBetween(inv.date, today));
      }
      return [...by.values()].sort((a, b) => b.oldestDays - a.oldestDays);
    });
  }

  /**
   * Market-basket pairs: how often two products appear on the same bill.
   * Map<productId, Map<otherId, count>> — used for "often bought with" hints.
   */
  function coPurchase() {
    return cached('copurchase', () => {
      const pairs = new Map();
      const counts = new Map();
      for (const inv of invoicesIn()) {
        const ids = [...new Set(inv.lines.map((l) => l.productId))];
        for (const a of ids) {
          counts.set(a, (counts.get(a) || 0) + 1);
          if (!pairs.has(a)) pairs.set(a, new Map());
          for (const b of ids) if (a !== b) pairs.get(a).set(b, (pairs.get(a).get(b) || 0) + 1);
        }
      }
      return { pairs, counts };
    });
  }

  /** Median quantity per product per bill, split B2B / B2C — the "normal" order size. */
  function typicalQty() {
    return cached('typicalQty', () => {
      const qtys = new Map();
      for (const inv of invoicesIn()) for (const l of inv.lines) {
        const k = l.productId + (inv.isB2B ? ':b2b' : ':b2c');
        if (!qtys.has(k)) qtys.set(k, []);
        qtys.get(k).push(l.qty);
      }
      const median = new Map();
      for (const [k, arr] of qtys) {
        arr.sort((a, b) => a - b);
        median.set(k, { median: arr[Math.floor(arr.length / 2)], samples: arr.length });
      }
      return median;
    });
  }

  /** Free-text + filter search over invoices. */
  function searchInvoices({ text = '', status = 'all', type = 'all', from = '', to = '' } = {}) {
    const q = text.trim().toLowerCase();
    return [...store.invoices.values()].filter((i) => {
      if (from && i.date < from) return false;
      if (to && i.date > to) return false;
      if (status === 'cancelled') { if (!i.cancelled) return false; }
      else if (status !== 'all' && (i.cancelled || i.status !== status)) return false;
      if (type === 'b2b' && !i.isB2B) return false;
      if (type === 'b2c' && i.isB2B) return false;
      if (type === 'inter' && !i.interState) return false;
      if (q) {
        const hay = (i.number + ' ' + i.customerName + ' ' + i.customerGstin + ' ' + i.lines.map((l) => l.name).join(' ')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
  }

  GST.analytics = { invoicesIn, kpis, monthlySeries, periodReport, weekdayPattern, restockForecast, receivables, coPurchase, typicalQty, searchInvoices, addDays, daysBetween };
})(window.GST);
