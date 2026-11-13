/* =========================================================
   app.js — start-up, hash router, global events, shortcuts
   Start-up order matters for perceived speed:
     1. load saved data synchronously and paint the dashboard
     2. THEN fetch the HSN rate list in the background; when it
        arrives, only the screens that use it refresh
   ========================================================= */
(function (GST) {
  'use strict';
  const { store, views, billing, ui } = GST;
  const { $, $$, toast } = ui;

  const VIEWS = new Set(['dashboard', 'new', 'invoices', 'products', 'customers', 'reports', 'settings']);
  const renderers = {
    dashboard: views.dashboard,
    new: billing.recalc,
    invoices: () => views.invoices(),
    products: views.products,
    customers: views.customers,
    reports: () => views.reports(),
    settings: views.settings,
  };
  const dirty = new Set(VIEWS); // views that need a re-render next time they are shown
  let current = null;

  function route() {
    const name = location.hash.slice(1) || 'dashboard';
    const view = VIEWS.has(name) ? name : 'dashboard';
    if (view !== name) history.replaceState(null, '', '#' + view);
    for (const sec of $$('.view')) sec.hidden = sec.id !== 'view-' + view;
    $$('.tabs a').forEach((a) => (a.dataset.view === view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    current = view;
    if (dirty.has(view)) { renderers[view](); dirty.delete(view); }
    document.title = `${$(`.tabs a[data-view="${view}"]`).textContent} · BillBhai`;
    if (view === 'new') setTimeout(() => $('#billCustomer').focus(), 0);
    $(`.tabs a[data-view="${view}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** On any data change: re-render the visible view now, mark the rest dirty. */
  store.addEventListener('change', () => {
    views.chrome();
    for (const v of VIEWS) dirty.add(v);
    if (current && current !== 'new') { renderers[current](); dirty.delete(current); }
    dirty.delete('new'); // billing.js listens for itself
    $('#saveDot').classList.toggle('is-error', Boolean(store.saveError));
  });
  store.addEventListener('save-error', (e) => {
    $('#saveDot').classList.add('is-error');
    $('#saveDot').title = 'Could not save on this device';
    toast(`Couldn't save to this browser (${e.detail.name}). Download a backup from Settings so you don't lose data.`, { type: 'err', duration: 8000 });
  });

  function wire() {
    window.addEventListener('hashchange', route);

    // Invoices
    const rerenderInvoices = GST.debounce(() => views.invoices({ resetPaging: true }), 200);
    $('#invSearch').addEventListener('input', rerenderInvoices);
    for (const id of ['#invStatus', '#invType', '#invFrom', '#invTo']) $(id).addEventListener('change', () => views.invoices({ resetPaging: true }));
    $('#invMore').addEventListener('click', views.moreInvoices);
    $('#exportInvoices').addEventListener('click', views.exportInvoicesCSV);
    const openRow = (e) => { const id = e.target.closest('tr[data-id]')?.dataset.id; if (id) views.openInvoice(id); };
    $('#invTable tbody').addEventListener('click', openRow);
    $('#invTable tbody').addEventListener('keydown', (e) => { if (e.key === 'Enter') openRow(e); });
    $('#invoiceActions').addEventListener('click', views.onInvoiceAction);
    $('[data-filter="unpaid"]').addEventListener('click', () => { $('#invStatus').value = 'unpaid'; dirty.add('invoices'); });

    // Products
    $('#addProduct').addEventListener('click', () => views.openProductDialog());
    $('#prodSearch').addEventListener('input', GST.debounce(views.products, 150));
    $('#prodFilter').addEventListener('change', views.products);
    $('#prodTable tbody').addEventListener('click', views.onProductAction);
    $('#productForm').addEventListener('submit', views.saveProduct);
    $('#productForm').elements.hsn.addEventListener('input', () => {
      const m = views.hsnHint();
      // Suggest the rate only for a new product; never silently change an existing one.
      if (m && !$('#productForm').elements.id.value) $('#productForm').elements.rate.value = String(m.rate);
    });
    ui.fillRateSelect($('#productForm').elements.rate);

    // Customers
    $('#addCustomer').addEventListener('click', () => views.openCustomerDialog());
    $('#custSearch').addEventListener('input', GST.debounce(views.customers, 150));
    $('#custTable tbody').addEventListener('click', views.onCustomerAction);
    $('#customerForm').addEventListener('submit', views.saveCustomer);
    $('#customerForm').elements.gstin.addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); views.customerGstinInput(); });
    ui.fillStateSelect($('#customerForm').elements.stateCode);

    // Reports
    $('#repPeriod').addEventListener('change', () => views.reports({ fromPeriod: true }));
    for (const id of ['#repFrom', '#repTo']) $(id).addEventListener('change', () => { $('#repPeriod').value = 'custom'; views.reports(); });
    $('#exportHsn').addEventListener('click', views.exportHsnCSV);

    // Settings
    $('#settingsForm').addEventListener('submit', views.saveSettings);
    $('#exportBackup').addEventListener('click', () => {
      GST.downloadJSON(store.toJSON(), `billbhai-backup-${GST.todayISO()}.json`);
      $('#backupStatus').className = 'status status--ok';
      $('#backupStatus').textContent = `Backup downloaded: ${store.invoices.size} invoices, ${store.products.size} products, ${store.customers.size} customers.`;
    });
    $('#importBackup').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = ''; // allow choosing the same file again
      const out = $('#backupStatus');
      out.className = 'status status--busy'; out.innerHTML = '<span class="spinner"></span> Reading backup…';
      try {
        const data = await GST.readBackupFile(file);
        const n = data.invoices?.length ?? 0;
        if (!confirm(`Replace ALL current data with this backup (${n} invoices, saved ${data.savedAt ? new Date(data.savedAt).toLocaleString('en-IN') : 'unknown date'})?`)) {
          out.className = 'status'; out.textContent = 'Restore cancelled. Nothing changed.'; return;
        }
        store.hydrate(data);
        billing.reset();
        out.className = 'status status--ok'; out.textContent = `Restored ${n} invoices.`;
        toast('Backup restored');
      } catch (err) {
        out.className = 'status status--err'; out.textContent = `Restore failed: ${err.message}. Your current data is untouched.`;
      }
    });
    $('#resetDemo').addEventListener('click', () => {
      if (!confirm('Replace everything with fresh demo data? Download a backup first if you need your current data.')) return;
      store.reset(); billing.reset();
      toast('Demo data restored');
    });
    $('#simOutage').addEventListener('change', (e) => {
      GST.net.simulateOutage = e.target.checked;
      toast(e.target.checked ? 'GST portal outage ON: GSTIN checks will fail after retries' : 'GST portal back online');
    });
    document.addEventListener('net-log', () => { if (current === 'settings') views.netLog(); });

    // Dialogs: [data-close] buttons, and clicking the backdrop
    for (const dlg of $$('dialog')) {
      dlg.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]') || e.target === dlg) dlg.close();
      });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
      if (document.querySelector('dialog[open]')) return;
      if (e.key.toLowerCase() === 'n' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); location.hash = 'new'; }
      if (current === 'new' && e.altKey && e.key.toLowerCase() === 'a') { e.preventDefault(); billing.addLine(); }
      if (current === 'new' && (e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); billing.save(); }
    });
  }

  /* ---------- start ---------- */
  function start() {
    const how = store.load();
    views.chrome();
    billing.init();
    wire();
    route();
    if (how === 'seeded') toast('Loaded demo data for a sample shop. Edit it in Settings, or reset any time.');

    // Non-blocking: the page is already usable while this loads.
    GST.hsn = null;
    GST.loadHsnMaster().then((hsn) => {
      GST.hsn = hsn;
      $('#hsnOptions').innerHTML = [...hsn.map].map(([code, m]) => `<option value="${code}">${GST.esc(m.description)} · ${m.rate}%</option>`).join('');
      for (const v of ['products', 'new']) dirty.add(v);
      if (current === 'products') { views.products(); dirty.delete('products'); }
      billing.recalc();
      if (hsn.source === 'fallback') console.info('HSN master: using built-in list (open via a local server to load data/hsn-rates.json)');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(window.GST);
