/* =========================================================
   models.js — domain objects and the GST calculation engine
   Product ─┐
            ├─< InvoiceLine >── Invoice ──> Customer (optional: walk-in B2C)
   Every class validates its own input and throws ValidationError
   with a field name, so the UI can highlight the exact input.
   ========================================================= */
(function (GST) {
  'use strict';
  const { toPaise, validateGSTIN, GST_SLABS, STATES, uid } = GST;

  class ValidationError extends Error {
    constructor(field, message) {
      super(message);
      this.name = 'ValidationError';
      this.field = field;
    }
  }

  const reqText = (v, field, label, max = 80) => {
    const s = String(v ?? '').trim();
    if (!s) throw new ValidationError(field, `${label} is required`);
    if (s.length > max) throw new ValidationError(field, `${label} must be under ${max} characters`);
    return s;
  };
  const reqNumber = (v, field, label, { min = 0, integer = false } = {}) => {
    if (v === '' || v === null || v === undefined) throw new ValidationError(field, `${label} is required`);
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ValidationError(field, `${label} must be a number`);
    if (n < min) throw new ValidationError(field, `${label} cannot be less than ${min}`);
    if (integer && !Number.isInteger(n)) throw new ValidationError(field, `${label} must be a whole number`);
    return n;
  };

  /* ---------------- Product ---------------- */
  class Product {
    constructor({ id, name, hsn, rate, price, stock, unit = 'pcs', reorderLevel = 5, priceIncludesTax = false }) {
      this.id = id || uid('p');
      this.name = reqText(name, 'name', 'Product name');
      this.hsn = String(hsn ?? '').trim();
      if (!/^\d{4}(\d{2}){0,2}$/.test(this.hsn)) {
        throw new ValidationError('hsn', 'HSN/SAC code must be 4, 6 or 8 digits');
      }
      this.rate = reqNumber(rate, 'rate', 'GST rate');
      if (!GST_SLABS.has(this.rate)) {
        throw new ValidationError('rate', `GST rate must be one of ${[...GST_SLABS].join(', ')}%`);
      }
      // price is always integer paise here; Product.fromForm converts typed rupees
      this.price = reqNumber(price, 'price', 'Price', { integer: true });
      if (this.price < 1) throw new ValidationError('price', 'Price must be more than ₹0');
      this.stock = reqNumber(stock, 'stock', 'Stock', { min: 0, integer: true });
      this.unit = reqText(unit, 'unit', 'Unit', 10);
      this.reorderLevel = reqNumber(reorderLevel, 'reorderLevel', 'Reorder level', { min: 0, integer: true });
      this.priceIncludesTax = Boolean(priceIncludesTax);
    }
    get isLowStock() { return this.stock <= this.reorderLevel; }
  }
  /** Build a Product from a form where price is typed in rupees. */
  // Converting only non-empty values lets the constructor report errors in field order (name first).
  Product.fromForm = (data) => new Product({ ...data, price: data.price === '' || data.price == null ? '' : toPaise(Number(data.price)) });
  /** Rebuild from storage where price is already paise. */
  Product.fromJSON = (o) => Object.assign(Object.create(Product.prototype), o);

  /* ---------------- Customer ---------------- */
  class Customer {
    constructor({ id, name, phone = '', gstin = '', stateCode = '', createdAt }) {
      this.id = id || uid('c');
      this.name = reqText(name, 'name', 'Customer name');
      this.phone = String(phone).trim();
      if (this.phone && !/^[6-9]\d{9}$/.test(this.phone)) {
        throw new ValidationError('phone', 'Phone must be a 10-digit Indian mobile number');
      }
      this.gstin = String(gstin).trim().toUpperCase();
      if (this.gstin) {
        const v = validateGSTIN(this.gstin);
        if (!v.ok) throw new ValidationError('gstin', v.reason);
        this.stateCode = v.stateCode; // GSTIN decides the state; no room for mismatch
      } else {
        if (!STATES.has(stateCode)) throw new ValidationError('stateCode', 'Select the customer\'s state');
        this.stateCode = stateCode;
      }
      this.createdAt = createdAt || new Date().toISOString();
    }
    get isB2B() { return Boolean(this.gstin); }
  }
  Customer.fromJSON = (o) => Object.assign(Object.create(Customer.prototype), o);

  /* ---------------- GST engine ----------------
     Rules implemented:
     • Intra-state supply (shop state === place of supply) → CGST + SGST, half each
     • Inter-state supply → IGST, full rate
     • Discount is applied before tax (taxable value = qty × price − discount)
     • Tax-inclusive (MRP) prices are back-calculated: taxable = price × 100/(100+rate)
     • CGST is rounded, SGST = tax − CGST, so the two halves always add up exactly */
  function computeLine({ qty, price, rate, discount = 0, priceIncludesTax = false }, interState) {
    const gross = qty * price;
    const afterDiscount = Math.max(0, gross - discount);
    const taxable = priceIncludesTax ? Math.round(afterDiscount * 100 / (100 + rate)) : afterDiscount;
    const tax = priceIncludesTax ? afterDiscount - taxable : Math.round(taxable * rate / 100);
    let cgst = 0, sgst = 0, igst = 0;
    if (interState) igst = tax;
    else { cgst = Math.round(tax / 2); sgst = tax - cgst; }
    return { gross, taxable, tax, cgst, sgst, igst, total: taxable + tax };
  }

  function computeTotals(lines, interState) {
    const t = { taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0, discount: 0, items: 0 };
    const computed = lines.map((l) => {
      const c = computeLine(l, interState);
      t.taxable += c.taxable; t.cgst += c.cgst; t.sgst += c.sgst; t.igst += c.igst; t.tax += c.tax;
      t.discount += l.discount || 0; t.items += l.qty;
      return { ...l, ...c };
    });
    const exact = t.taxable + t.tax;
    t.grandTotal = Math.round(exact / 100) * 100; // round off to nearest rupee, as shops do
    t.roundOff = t.grandTotal - exact;
    return { lines: computed, totals: t };
  }

  /* ---------------- Invoice ---------------- */
  class Invoice {
    constructor({ id, number, date, customerId = null, customerName = 'Walk-in Customer', customerGstin = '',
      placeOfSupply, shopStateCode, lines, status = 'unpaid', paymentMode = 'cash', notes = '', createdAt, cancelled = false }) {
      this.id = id || uid('inv');
      this.number = number;
      if (!date || Number.isNaN(Date.parse(date))) throw new ValidationError('date', 'Invoice date is invalid');
      if (date > GST.todayISO()) throw new ValidationError('date', 'Invoice date cannot be in the future');
      this.date = date;
      this.customerId = customerId;
      this.customerName = customerName;
      this.customerGstin = customerGstin;
      if (!STATES.has(placeOfSupply)) throw new ValidationError('placeOfSupply', 'Select a valid place of supply');
      this.placeOfSupply = placeOfSupply;
      this.shopStateCode = shopStateCode;
      if (!Array.isArray(lines) || lines.length === 0) throw new ValidationError('lines', 'Add at least one item');
      this.lines = lines.map((l, i) => {
        if (!(l.qty > 0) || !Number.isInteger(l.qty)) throw new ValidationError('lines', `Row ${i + 1}: quantity must be a whole number above 0`);
        if (!(l.price > 0)) throw new ValidationError('lines', `Row ${i + 1}: price must be above 0`);
        if (l.discount < 0 || l.discount > l.qty * l.price) throw new ValidationError('lines', `Row ${i + 1}: discount cannot exceed the line amount`);
        return { productId: l.productId, name: l.name, hsn: l.hsn, unit: l.unit, qty: l.qty, price: l.price,
          rate: l.rate, discount: l.discount || 0, priceIncludesTax: !!l.priceIncludesTax };
      });
      this.status = status;
      this.paymentMode = paymentMode;
      this.notes = String(notes).slice(0, 200);
      this.createdAt = createdAt || new Date().toISOString();
      this.cancelled = cancelled;
      // Snapshot of the computed values: an issued invoice must never change
      // even if product prices or GST rates are edited later.
      const { lines: computed, totals } = computeTotals(this.lines, this.interState);
      this.computed = computed;
      this.totals = totals;
    }
    get interState() { return this.placeOfSupply !== this.shopStateCode; }
    get isB2B() { return Boolean(this.customerGstin); }
  }
  Invoice.fromJSON = (o) => Object.assign(Object.create(Invoice.prototype), o);

  Object.assign(GST, { ValidationError, Product, Customer, Invoice, computeLine, computeTotals });
})(window.GST);
