/* =========================================================
   guard.js — Invoice Guard (the "intelligent enhancement")
   Runs on every keystroke while a bill is being made and returns
   a list of findings, each with a severity and, where possible, a
   one-click fix. Errors block saving; warnings ask for a second look.

   Why: a GST invoice cannot be edited once issued (it can only be
   cancelled), and wrong tax type or rate means a mismatch in the
   buyer's input-tax credit and the shop's GSTR-1. Catching these
   while typing is far cheaper than a credit note after filing.
   ========================================================= */
(function (GST) {
  'use strict';
  const { store, analytics, money, STATES, CURRENT_SLABS, GST2_EFFECTIVE } = GST;

  const B2CL_LIMIT = 100000 * 100;   // inter-state B2C invoice above ₹1 lakh → reported invoice-wise (B2CL)
  const EWAY_LIMIT = 50000 * 100;    // goods worth over ₹50,000 moved → e-way bill needed
  const DUPLICATE_WINDOW_MIN = 30;

  /**
   * @param {object} draft   { date, customerId, customerGstin, placeOfSupply, lines:[{productId,qty,price,rate,discount,...}] }
   * @param {object} ctx     { hsnMaster: Map, gstinStatus: {status, legalName}|null, totals }
   * @returns {Array<{level:'error'|'warn'|'info', code:string, message:string, fix?:{label:string, apply:Function}}>}
   */
  function check(draft, ctx) {
    const out = [];
    const add = (level, code, message, fix) => out.push({ level, code, message, fix });
    const shopState = store.settings.stateCode;

    /* ---- Tax type ---- */
    if (draft.placeOfSupply && draft.lines.length) {
      if (draft.placeOfSupply !== shopState) {
        add('info', 'inter', `Inter-state supply to ${STATES.get(draft.placeOfSupply)}: IGST is charged instead of CGST + SGST.`);
      }
    }
    if (draft.customerGstin) {
      const v = GST.validateGSTIN(draft.customerGstin);
      if (!v.ok) add('error', 'gstin', `Customer GSTIN: ${v.reason}`);
      else if (v.stateCode !== draft.placeOfSupply) {
        add('warn', 'pos', `GSTIN is registered in ${v.state}, but place of supply is ${STATES.get(draft.placeOfSupply)}.`, {
          label: `Set to ${v.state}`, apply: (form) => form.setPlaceOfSupply(v.stateCode),
        });
      }
    }
    const st = ctx.gstinStatus;
    if (st && st.status !== 'Active') {
      add('error', 'gstin-status', `This GSTIN is ${st.status.toUpperCase()} on the GST portal. The buyer cannot claim input tax credit; bill as unregistered (B2C) instead.`);
    }
    if (st && st.type === 'Composition') {
      add('info', 'composition', 'Buyer is a composition dealer: they cannot claim input tax credit on this bill.');
    }

    /* ---- Line-level checks ---- */
    const need = new Map();
    const typical = analytics.typicalQty();
    draft.lines.forEach((l, idx) => {
      const row = `Row ${idx + 1} (${l.name || 'item'})`;
      if (!l.productId) { add('error', 'row-empty', `Row ${idx + 1}: choose a product or remove the row.`); return; }
      if (!(l.qty > 0) || !Number.isInteger(l.qty)) add('error', 'qty', `${row}: quantity must be a whole number above 0.`);
      if (l.discount > l.qty * l.price) add('error', 'discount', `${row}: discount is more than the line amount.`);
      else if (l.discount > 0.3 * l.qty * l.price) add('warn', 'discount-high', `${row}: discount is over 30% of the line amount.`);

      need.set(l.productId, (need.get(l.productId) || 0) + (l.qty || 0));

      const master = ctx.hsnMaster?.get(l.hsn) || ctx.hsnMaster?.get(String(l.hsn).slice(0, 4));
      if (master && master.rate !== l.rate) {
        add('warn', 'rate', `${row}: HSN ${l.hsn} (${master.description}) is normally taxed at ${master.rate}%, not ${l.rate}%.`, {
          label: `Use ${master.rate}% for this product`, apply: (form) => form.fixProductRate(l.productId, master.rate),
        });
      } else if (!CURRENT_SLABS.has(l.rate) && draft.date >= GST2_EFFECTIVE) {
        add('warn', 'legacy-slab', `${row}: the ${l.rate}% slab was removed by GST 2.0 on 22 Sep 2025. Check this product's current rate.`);
      }

      // Anomaly: far larger than this product's usual order size — likely a typo (10 vs 100).
      const t = typical.get(l.productId + (draft.customerGstin ? ':b2b' : ':b2c'));
      if (t && t.samples >= 5 && l.qty >= Math.max(10, t.median * 8)) {
        add('warn', 'qty-unusual', `${row}: ${l.qty} ${l.unit} is ${Math.round(l.qty / t.median)}× the usual quantity (${t.median}). Typo?`);
      }
    });

    for (const [pid, qty] of need) {
      const p = store.products.get(pid);
      if (!p) add('error', 'gone', 'An item on this bill was deleted from your products.');
      else if (qty > p.stock) add('error', 'stock', `${p.name}: only ${p.stock} ${p.unit} in stock, bill has ${qty}.`);
      else if (p.stock - qty <= p.reorderLevel) add('info', 'reorder', `${p.name} will drop to ${p.stock - qty} ${p.unit} after this sale (reorder level ${p.reorderLevel}).`);
    }

    /* ---- Bill-level checks ---- */
    const total = ctx.totals?.grandTotal || 0;
    if (!draft.customerGstin && draft.placeOfSupply !== shopState && total > B2CL_LIMIT) {
      add('info', 'b2cl', 'Inter-state B2C bill over ₹1 lakh: it is reported invoice-wise in GSTR-1 (B2CL). Record the buyer\'s name and address.');
    }
    if (total > EWAY_LIMIT) add('info', 'eway', `Bill value ${money(total)} is over ₹50,000: an e-way bill is needed if these goods are transported.`);

    // Possible double billing: same buyer, same amount, a few minutes apart.
    if (total > 0) {
      const now = Date.now();
      for (const inv of store.invoices.values()) {
        if (inv.cancelled || inv.date !== draft.date) continue;
        const sameBuyer = (inv.customerId || null) === (draft.customerId || null);
        const minutes = (now - Date.parse(inv.createdAt)) / 60000;
        if (sameBuyer && inv.totals.grandTotal === total && minutes < DUPLICATE_WINDOW_MIN) {
          add('warn', 'duplicate', `Looks like a duplicate of ${inv.number} (same buyer and amount, ${Math.max(1, Math.round(minutes))} min ago).`);
          break;
        }
      }
    }

    // Customer already owes money for over 30 days.
    if (draft.customerId) {
      const owed = analytics.receivables().find((r) => r.customerId === draft.customerId);
      if (owed && owed.oldestDays > 30) {
        add('warn', 'credit', `${owed.name} has ${money(owed.amount)} unpaid, oldest bill ${owed.oldestDays} days old. Collect before giving more credit?`);
      }
    }
    const order = { error: 0, warn: 1, info: 2 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
  }

  /** "Often bought with": products that co-occur with the cart but are not in it yet. */
  function suggestions(productIds, limit = 3) {
    const { pairs, counts } = analytics.coPurchase();
    const inCart = new Set(productIds);
    const score = new Map();
    for (const id of inCart) {
      const row = pairs.get(id);
      if (!row) continue;
      for (const [other, n] of row) {
        if (inCart.has(other)) continue;
        const p = store.products.get(other);
        if (!p || p.stock === 0) continue;
        // confidence = P(other | id): share of bills with `id` that also had `other`
        score.set(other, Math.max(score.get(other) || 0, n / counts.get(id)));
      }
    }
    return [...score].filter(([, s]) => s >= 0.25).sort((a, b) => b[1] - a[1]).slice(0, limit)
      .map(([id, s]) => ({ product: store.products.get(id), confidence: s }));
  }

  GST.guard = { check, suggestions };
})(window.GST);
