/* =========================================================
   store.js — single source of truth
   • Map<id, entity> for products, customers, invoices (O(1) lookup by id)
   • Secondary indexes: invoices by customer, invoices by product
   • Emits 'change' events (EventTarget) so every view re-renders itself
   • Persists to localStorage (debounced), with a versioned schema
   ========================================================= */
(function (GST) {
  'use strict';
  const { Product, Customer, Invoice, ValidationError, financialYear, todayISO, toPaise } = GST;

  const STORAGE_KEY = 'gst-ledger:v1';
  const SCHEMA_VERSION = 1;

  class Store extends EventTarget {
    constructor() {
      super();
      this.settings = {};
      this.products = new Map();
      this.customers = new Map();
      this.invoices = new Map();
      this.byCustomer = new Map(); // customerId -> Set<invoiceId>
      this.byProduct = new Map();  // productId  -> Set<invoiceId>
      this.counters = new Map();   // financial year -> last invoice serial
      this.saveError = null;
      this._save = GST.debounce(() => this.persist(), 250);
    }

    /* ---------- events ---------- */
    emit(type, detail = {}) {
      this._save();
      this.dispatchEvent(new CustomEvent('change', { detail: { type, ...detail } }));
    }

    /* ---------- indexes ---------- */
    _index(inv) {
      const add = (map, key) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(inv.id); };
      if (inv.customerId) add(this.byCustomer, inv.customerId);
      for (const l of inv.lines) add(this.byProduct, l.productId);
    }
    invoicesFor(customerId) {
      return [...(this.byCustomer.get(customerId) || [])].map((id) => this.invoices.get(id));
    }

    /* ---------- settings ---------- */
    updateSettings(patch) {
      const next = { ...this.settings, ...patch };
      next.shopName = String(next.shopName || '').trim();
      if (!next.shopName) throw new ValidationError('shopName', 'Shop name is required');
      const v = GST.validateGSTIN(next.gstin);
      if (!v.ok) throw new ValidationError('gstin', v.reason);
      next.gstin = v.gstin;
      next.stateCode = v.stateCode;
      this.settings = next;
      this.emit('settings');
    }

    /* ---------- products ---------- */
    upsertProduct(data, { fromForm = true } = {}) {
      const p = fromForm ? Product.fromForm(data) : new Product(data);
      const dupe = [...this.products.values()].find((x) => x.id !== p.id && x.name.toLowerCase() === p.name.toLowerCase());
      if (dupe) throw new ValidationError('name', `A product named "${dupe.name}" already exists`);
      const isNew = !this.products.has(p.id);
      this.products.set(p.id, p);
      this.emit(isNew ? 'product:add' : 'product:update', { id: p.id });
      return p;
    }
    deleteProduct(id) {
      const p = this.products.get(id);
      if (!p) return;
      this.products.delete(id);
      // Past invoices keep their own snapshot of name/HSN/price, so history stays intact.
      this.emit('product:delete', { id, name: p.name });
      return p;
    }
    restoreProduct(p) { this.products.set(p.id, p); this.emit('product:add', { id: p.id }); }
    adjustStock(id, delta) {
      const p = this.products.get(id);
      if (!p) throw new Error('Product not found');
      if (p.stock + delta < 0) throw new ValidationError('stock', `Only ${p.stock} ${p.unit} of ${p.name} in stock`);
      p.stock += delta;
      this.emit('product:stock', { id });
    }

    /* ---------- customers ---------- */
    upsertCustomer(data) {
      const c = new Customer(data);
      if (c.gstin) {
        const dupe = [...this.customers.values()].find((x) => x.id !== c.id && x.gstin === c.gstin);
        if (dupe) throw new ValidationError('gstin', `GSTIN already saved for "${dupe.name}"`);
      }
      if (c.phone) {
        const dupe = [...this.customers.values()].find((x) => x.id !== c.id && x.phone === c.phone);
        if (dupe) throw new ValidationError('phone', `Phone number already saved for "${dupe.name}"`);
      }
      const isNew = !this.customers.has(c.id);
      this.customers.set(c.id, c);
      this.emit(isNew ? 'customer:add' : 'customer:update', { id: c.id });
      return c;
    }
    deleteCustomer(id) {
      const c = this.customers.get(id);
      if (!c) return;
      this.customers.delete(id);
      this.emit('customer:delete', { id, name: c.name });
      return c;
    }
    restoreCustomer(c) { this.customers.set(c.id, c); this.emit('customer:add', { id: c.id }); }

    /* ---------- invoices ---------- */
    nextInvoiceNumber(date = todayISO(), peek = true) {
      const fy = financialYear(date);
      const n = (this.counters.get(fy) || 0) + 1;
      if (!peek) this.counters.set(fy, n);
      return `INV/${fy}/${String(n).padStart(4, '0')}`;
    }

    /**
     * Create an invoice and reduce stock — all or nothing.
     * Stock is checked for every line first, so a failure on line 3
     * never leaves lines 1–2 already deducted.
     */
    createInvoice(draft) {
      const need = new Map();
      for (const l of draft.lines) need.set(l.productId, (need.get(l.productId) || 0) + l.qty);
      for (const [pid, qty] of need) {
        const p = this.products.get(pid);
        if (!p) throw new ValidationError('lines', 'An item on this bill no longer exists in your product list');
        if (p.stock < qty) throw new ValidationError('lines', `Not enough stock: ${p.name} has ${p.stock} ${p.unit}, bill needs ${qty}`);
      }
      const inv = new Invoice({
        ...draft,
        number: this.nextInvoiceNumber(draft.date, true),
        shopStateCode: this.settings.stateCode,
      });
      this.nextInvoiceNumber(draft.date, false); // commit the serial only after validation passed
      for (const [pid, qty] of need) this.products.get(pid).stock -= qty;
      this.invoices.set(inv.id, inv);
      this._index(inv);
      this.emit('invoice:add', { id: inv.id });
      return inv;
    }

    setInvoiceStatus(id, status) {
      const inv = this.invoices.get(id);
      if (!inv || inv.cancelled) return;
      inv.status = status;
      this.emit('invoice:update', { id });
    }

    /** GST law: an issued invoice is not deleted; it is cancelled and stock returns. */
    cancelInvoice(id) {
      const inv = this.invoices.get(id);
      if (!inv || inv.cancelled) return;
      inv.cancelled = true;
      for (const l of inv.lines) {
        const p = this.products.get(l.productId);
        if (p) p.stock += l.qty;
      }
      this.emit('invoice:cancel', { id });
    }

    /* ---------- persistence ---------- */
    toJSON() {
      return {
        version: SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        settings: this.settings,
        products: [...this.products.values()],
        customers: [...this.customers.values()],
        invoices: [...this.invoices.values()],
        counters: Object.fromEntries(this.counters),
      };
    }

    persist() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
        this.saveError = null;
      } catch (err) {
        // QuotaExceededError, or storage disabled in a private window
        this.saveError = err;
        this.dispatchEvent(new CustomEvent('save-error', { detail: err }));
      }
    }

    /** Load a plain object (from localStorage or an imported backup). Throws if malformed. */
    hydrate(data) {
      if (!data || typeof data !== 'object') throw new Error('Backup is not a valid object');
      if (data.version !== SCHEMA_VERSION) throw new Error(`Unsupported backup version: ${data.version}`);
      for (const key of ['products', 'customers', 'invoices']) {
        if (!Array.isArray(data[key])) throw new Error(`Backup is missing the "${key}" list`);
      }
      if (!GST.validateGSTIN(data.settings?.gstin).ok) throw new Error('Backup has an invalid shop GSTIN');
      // Validate every record before replacing anything, so a bad file can't half-load.
      const products = data.products.map((o) => { new Product(o); return Product.fromJSON(o); });
      const customers = data.customers.map((o) => { new Customer(o); return Customer.fromJSON(o); });
      const invoices = data.invoices.map((o) => {
        if (!o.id || !o.number || !Array.isArray(o.lines) || !o.totals) throw new Error(`Invoice ${o.number || '?'} is incomplete`);
        return Invoice.fromJSON(o);
      });
      this.settings = data.settings;
      this.products = new Map(products.map((p) => [p.id, p]));
      this.customers = new Map(customers.map((c) => [c.id, c]));
      this.invoices = new Map(invoices.map((i) => [i.id, i]));
      this.counters = new Map(Object.entries(data.counters || {}));
      this.byCustomer.clear(); this.byProduct.clear();
      for (const inv of this.invoices.values()) this._index(inv);
      this.emit('hydrate');
    }

    load() {
      let raw = null;
      try { raw = localStorage.getItem(STORAGE_KEY); } catch { /* storage blocked */ }
      if (raw) {
        try { this.hydrate(JSON.parse(raw)); return 'restored'; }
        catch (err) { console.warn('Saved data was unreadable, loading demo data', err); }
      }
      this.seed();
      return 'seeded';
    }

    reset() { this.seed(); }

    /* ---------- demo data ---------- */
    seed() {
      this.settings = {
        shopName: 'Sharma General & Electricals',
        address: '14, 3rd Cross, Jayanagar 4th Block, Bengaluru 560011',
        phone: '9845012345',
        gstin: '29ABCDE1234F1ZW',
        stateCode: '29',
      };
      const P = (id, name, hsn, rate, rupees, stock, unit, reorderLevel, priceIncludesTax = false) =>
        new Product({ id, name, hsn, rate, price: toPaise(rupees), stock, unit, reorderLevel, priceIncludesTax });
      const products = [
        P('p_rice', 'Sona Masoori Rice 25 kg', '1006', 5, 1450, 18, 'bag', 5),
        P('p_atta', 'Whole Wheat Atta 10 kg', '1101', 5, 420, 24, 'bag', 6),
        P('p_sugar', 'Sugar 1 kg', '1701', 5, 46, 60, 'kg', 15),
        P('p_dal', 'Toor Dal 1 kg', '0713', 5, 165, 4, 'kg', 10),
        P('p_oil', 'Sunflower Oil 1 L', '1512', 5, 155, 36, 'btl', 10),
        P('p_tea', 'Assam Tea 250 g', '0902', 5, 140, 22, 'pkt', 8),
        P('p_milk', 'Toned Milk 500 ml', '0401', 0, 27, 40, 'pkt', 20),
        P('p_ghee', 'Cow Ghee 500 ml', '0405', 5, 330, 3, 'jar', 4, true),
        P('p_biscuit', 'Glucose Biscuits 800 g', '1905', 5, 95, 48, 'pkt', 12, true),
        P('p_soap', 'Bath Soap (pack of 4)', '3401', 5, 160, 30, 'pack', 8, true),
        P('p_paste', 'Toothpaste 150 g', '3306', 5, 105, 26, 'pcs', 8, true),
        P('p_deterg', 'Detergent Powder 1 kg', '3402', 18, 125, 2, 'pkt', 6),
        P('p_cola', 'Cola 750 ml', '2202', 40, 45, 50, 'btl', 12, true),
        P('p_notebook', 'Ruled Notebook 172 pg', '4820', 0, 55, 70, 'pcs', 15),
        P('p_bulb', 'LED Bulb 9 W', '8539', 18, 99, 45, 'pcs', 10),
        P('p_board', 'Extension Board 4-socket', '8536', 18, 420, 9, 'pcs', 3),
        P('p_wire', 'Copper Wire 1.5 sq mm (90 m)', '8544', 18, 1890, 6, 'coil', 2),
        P('p_fan', 'Ceiling Fan 1200 mm', '8414', 18, 2350, 7, 'pcs', 2),
      ];
      const customers = [
        new Customer({ id: 'c_maruthi', name: 'Maruthi Electricals', phone: '9880011223', gstin: '29AAGCM4821K1Z6' }),
        new Customer({ id: 'c_srinidhi', name: 'Srinidhi Caterers', phone: '9741122334', gstin: '29BXHPS7712Q1ZG' }),
        new Customer({ id: 'c_techno', name: 'Techno Build Pvt Ltd (Pune)', phone: '9822033445', gstin: '27AACCT5531R1ZS' }),
        new Customer({ id: 'c_kaveri', name: 'Kaveri Traders (Hosur)', phone: '9443044556', gstin: '33AAFFK9087L1ZS' }),
        new Customer({ id: 'c_ravi', name: 'Ravi Kumar', phone: '9900155667', stateCode: '29' }),
        new Customer({ id: 'c_anita', name: 'Anita Desai', phone: '9611266778', stateCode: '29' }),
        new Customer({ id: 'c_nandi', name: 'Nandi Hostel Mess', phone: '9535377889', gstin: '29AAKFN6345D1Z3' }),
      ];
      this.products = new Map(products.map((p) => [p.id, p]));
      this.customers = new Map(customers.map((c) => [c.id, c]));
      this.invoices = new Map();
      this.byCustomer.clear(); this.byProduct.clear(); this.counters.clear();

      // Deterministic pseudo-random history (mulberry32) so the demo looks the same every reset.
      let s = 20261113;
      const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
      const baskets = [
        ['p_rice', 'p_dal', 'p_oil'], ['p_atta', 'p_sugar', 'p_tea'], ['p_milk', 'p_biscuit'],
        ['p_soap', 'p_paste', 'p_deterg'], ['p_bulb', 'p_board'], ['p_wire', 'p_board', 'p_bulb'],
        ['p_fan', 'p_wire'], ['p_tea', 'p_biscuit', 'p_milk'], ['p_notebook'], ['p_cola', 'p_biscuit'],
        ['p_ghee', 'p_atta', 'p_dal'],
      ];
      const today = new Date(todayISO() + 'T00:00:00');
      const dates = [];
      for (let back = 190; back >= 0; back--) {
        const d = new Date(today); d.setDate(d.getDate() - back);
        const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        const perDay = rnd() < 0.35 ? 0 : (rnd() < 0.6 ? 1 : 2) + (back < 45 && rnd() < 0.4 ? 1 : 0); // busier recently
        for (let k = 0; k < perDay; k++) dates.push(iso);
      }
      for (const date of dates) {
        const r = rnd();
        const cust = r < 0.55 ? null : pick(customers);
        const basket = pick(baskets).filter(() => rnd() < 0.85);
        if (basket.length === 0) basket.push('p_sugar');
        if (cust?.isB2B && rnd() < 0.5) basket.push(pick(['p_bulb', 'p_wire', 'p_rice', 'p_oil']));
        const qtyScale = cust?.isB2B ? 4 : 1;
        const lines = [...new Set(basket)].map((pid) => {
          const p = this.products.get(pid);
          const qty = Math.max(1, Math.round((1 + rnd() * 2) * (p.price > 100000 ? 1 : qtyScale)));
          const discount = rnd() < 0.15 ? Math.round(qty * p.price * 0.05) : 0;
          return { productId: p.id, name: p.name, hsn: p.hsn, unit: p.unit, qty, price: p.price, rate: p.rate, discount, priceIncludesTax: p.priceIncludesTax };
        });
        const daysAgo = (today - new Date(date + 'T00:00:00')) / 864e5;
        const inv = new Invoice({
          number: this.nextInvoiceNumber(date, false), date,
          customerId: cust?.id || null, customerName: cust?.name || 'Walk-in Customer', customerGstin: cust?.gstin || '',
          placeOfSupply: cust?.stateCode || '29', shopStateCode: '29', lines,
          status: !cust ? 'paid' : (daysAgo > 40 || rnd() < 0.6 ? 'paid' : 'unpaid'),
          paymentMode: !cust ? pick(['cash', 'upi', 'upi', 'card']) : pick(['upi', 'bank', 'credit']),
          createdAt: date + 'T10:00:00.000Z',
        });
        this.invoices.set(inv.id, inv);
        this._index(inv);
      }
      // One cancelled invoice so the "cancelled" path is visible in the demo.
      const last = [...this.invoices.values()].at(-6);
      if (last) last.cancelled = true;
      this.emit('hydrate');
    }
  }

  GST.store = new Store();
})(window.GST);
