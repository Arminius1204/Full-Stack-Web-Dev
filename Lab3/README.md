# BillBhai: GST invoicing for small shop owners

**Full Stack Web Development, Lab 3: Interactive JavaScript application**

BillBhai is a browser app that lets a small shop make GST tax invoices, track stock and get GSTR-1 summaries without accounting software. It uses plain HTML, CSS and JavaScript, with no build step and no framework.

The full write-up for each assessment criterion is in [REPORT.md](REPORT.md).

## Running it

| Method | What you get |
| :--- | :--- |
| Double-click `index.html` | Everything works. The HSN rate list can't be fetched from `file://`, so the app falls back to its built-in copy (this is the async failure path). |
| `npx serve .` or VS Code Live Server, then open the URL | Same app. The HSN list loads from `data/hsn-rates.json` with `fetch()`. |

On first load the app fills itself with about 6 months of demo data for a sample Bengaluru shop. You can restore it any time with **Settings → Reset demo data**.

### Things to try

1. **New bill**: pick *Sona Masoori Rice*, then click a suggested item under "Often bought with these".
2. Type the GSTIN `27AACCT5531R1ZS`. The customer is linked, place of supply switches to Maharashtra, and tax changes from CGST + SGST to IGST.
3. Change the last character of that GSTIN to `X`. The checksum fails immediately, with no network call.
4. Try `29AJXPR2290M1Z3`. The format is valid, but the simulated portal reports it as **Cancelled**, and Invoice Guard blocks the B2B bill.
5. Set a quantity of 50 for an item with only 4 in stock. Invoice Guard blocks the save.
6. **Settings → Simulate GST portal outage**: verify a GSTIN and watch the retries, then the fallback, in the network log.
7. **GST reports**: rate-wise tax, HSN summary (GSTR-1 Table 12), B2B and B2C tables, and CSV export.
8. **Invoices**: open any invoice, then *Print / PDF*, *Mark as paid* or *Cancel* (cancelling returns the stock).

Keyboard shortcuts: `N` opens a new bill, `Alt+A` adds an item, `Ctrl+Enter` saves the bill.

## Files

```
Lab3/
├── index.html            page shell: 7 views + 3 dialogs
├── css/styles.css        design tokens, layout, print stylesheet
├── data/hsn-rates.json   HSN → GST rate master (loaded asynchronously)
└── js/
    ├── utils.js          money in paise, INR formatting, GSTIN checksum, state codes, amount in words
    ├── models.js         Product, Customer, Invoice classes + GST calculation engine
    ├── store.js          Store (EventTarget): Maps, indexes, persistence, demo data
    ├── services.js       async: fetch with timeout, retry with backoff, GSTIN verification, backup file
    ├── analytics.js      KPIs, monthly trend, weekday pattern, GSTR-1 reports, restock forecast
    ├── guard.js          Invoice Guard (the original feature) + "often bought with" suggestions
    ├── ui.js             DOM helpers, toasts, form errors, SVG charts
    ├── views.js          dashboard, lists, reports, settings, dialogs
    ├── billing.js        new-bill editor
    └── app.js            start-up, hash router, shortcuts
```

The scripts are classic `<script>` tags that share one `GST` namespace, not ES modules. Chrome and Edge block modules on `file://`, and the app needs to open with a double-click.

## Where each course concept is used

| Concept | Where |
| :--- | :--- |
| Objects and classes | `Product`, `Customer`, `Invoice`, `ValidationError`, `NetworkError` ([models.js](js/models.js), [services.js](js/services.js)); `Store extends EventTarget` ([store.js](js/store.js)) |
| Arrays | invoice lines, `map`/`filter`/`reduce`/`sort` across [analytics.js](js/analytics.js), [views.js](js/views.js) |
| Sets | `GST_SLABS`/`CURRENT_SLABS` membership checks, unique customers in KPIs, de-duplicated basket items, invoice indexes `Map<customerId, Set<invoiceId>>` |
| Maps | entity stores by id, `STATES`, HSN master, single-pass report builders, co-purchase matrix `Map<id, Map<id, count>>`, GSTIN response cache, in-flight request dedupe |
| Event handling | delegated listeners on tables and bill rows, `input`/`change`/`submit`, custom `change` events from the store, `hashchange` routing, keyboard shortcuts, `<dialog>` handling |
| Asynchronous programming | `fetch` + `AbortController` timeout, `async`/`await`, retry with exponential backoff, request cancellation on new input, `Promise`-based file reading, debounced saving |
| Error handling | field-level `ValidationError`s shown next to the input, all-or-nothing stock deduction, backup validated before anything is replaced, `localStorage` quota errors surfaced to the user |

## Disclaimer

GST rates follow the GST 2.0 rationalisation (effective 22 Sep 2025) as I understand it. Check them against current CBIC notifications before using this for real filing. The GSTIN status lookup is simulated, because the real GST search API needs GSP credentials.
