# Lab 3 report: BillBhai, GST invoicing for small shop owners

## 1. Problem analysis

**The problem.** A small kirana or electrical shop in India that is registered for GST has to issue a proper tax invoice for every sale, collect the right tax and report every sale in GSTR-1 each month or quarter. Most of these shops still use handwritten bill books or a spreadsheet. That leads to the same mistakes again and again:

| Mistake | Consequence |
| :--- | :--- |
| Charging CGST + SGST on an out-of-state sale (or IGST on a local one) | Tax paid under the wrong head; the shop must pay again and claim a refund |
| Wrong GST rate for an item (common after the Sept 2025 rate changes) | Short-paid tax with interest, or overcharged customers |
| A typo in the buyer's GSTIN | The buyer's input tax credit doesn't show up; the business customer complains |
| Selling stock that isn't on the shelf; no idea what to reorder | Lost sales; cash stuck in slow stock |
| Not knowing who owes money | Credit customers pay late |
| Rebuilding the HSN and B2B/B2C summaries by hand at filing time | Hours of work for the shop or the CA every month |

**Users.** The shop owner, or a counter assistant, working at a busy counter on a laptop or phone. They are not accountants, so the app has to explain itself in plain words and catch mistakes as they happen.

**Requirements derived from this:**

- Build a bill quickly; tax type and amounts are worked out automatically
- Validate GSTINs properly (format, state code and checksum), plus a status check against the GST portal
- Keep invoices unchangeable once issued (they can be cancelled, never edited or deleted)
- Keep stock in sync with sales
- Produce GSTR-1-ready summaries and insights the owner can act on
- Work offline in a single browser, and never lose data silently

## 2. Data modelling

```
Settings (shop name, GSTIN → state code)
Product  { id, name, hsn, rate, price(paise), stock, unit, reorderLevel, priceIncludesTax }
Customer { id, name, phone, gstin?, stateCode }
Invoice  { id, number, date, customerId?, customerName, customerGstin, placeOfSupply, shopStateCode,
           lines[ {productId, name, hsn, unit, qty, price, rate, discount, priceIncludesTax} ],
           computed[], totals{taxable,cgst,sgst,igst,tax,roundOff,grandTotal},
           status, paymentMode, cancelled }
```

Key decisions:

- **Money is stored as integer paise.** In floating point, `0.1 + 0.2 !== 0.3`. With integers every split is exact, and rounding happens in exactly one place.
- **An invoice stores a snapshot** of each product's name, HSN, price and rate. When a product's price or rate changes later, issued invoices stay correct. That is a legal requirement, and it also means a product can be deleted without breaking history.
- **The customer's state comes from their GSTIN** (its first two digits), so the state and the GSTIN can never disagree.
- **Storage uses Maps keyed by id** (`products`, `customers`, `invoices`) for O(1) lookup, plus secondary indexes `byCustomer` and `byProduct` (`Map<id, Set<invoiceId>>`). A customer's history therefore never needs a scan of every invoice.
- **Invoice numbers run per financial year** (`INV/2026-27/0001`) through a `counters` Map. The serial is committed only after validation passes, so a failed save never leaves a gap in the numbering.
- **Support for change:** products and customers can be added, edited and deleted (with Undo), stock can be adjusted, invoices can be marked paid/unpaid or cancelled (which returns stock), and the shop profile can be edited. Changing the shop's GSTIN changes its state, which changes the tax split on new bills. All data can be exported and restored, and the backup format carries a version number.

## 3. Data processing and insights

All reports live in [js/analytics.js](js/analytics.js). Two efficiency choices:

1. **Single-pass aggregation.** `periodReport()` walks the invoices once and fills six Maps at the same time: rate slabs, HSN summary, B2B by GSTIN, B2C by state + rate, products and customers. The alternative is filtering the array six times.
2. **Memoisation.** Results are cached by store version, and every store change bumps the version. Switching tabs therefore never recomputes anything.

| Insight | How it's computed | What the owner does with it |
| :--- | :--- | :--- |
| 30-day KPIs with % change vs the previous 30 days | two windowed sums; a `Set` for unique customers | sees if the business is growing |
| 6-month sales and GST trend | `Map<month, totals>` pre-filled with empty months | spots seasonal dips |
| Busiest weekday | 90 days grouped by `getDay()` | plans staff and restocking |
| Restock forecast | average daily units sold over 30 days → days of stock left, suggested order quantity | orders before running out |
| Money to collect | unpaid invoices grouped by customer, age of the oldest bill | chases late payers |
| Tax by rate, HSN summary (GSTR-1 Table 12), B2B (Table 4), B2C (Table 7) | single-pass report | hands the CSV to the CA |
| "Often bought with" | co-purchase matrix `Map<id, Map<id, count>>`, confidence = P(B given A) | suggests add-ons at the counter |
| Normal order size per product | median quantity per product, split B2B/B2C | feeds the typo detector in Invoice Guard |

## 4. Interactive functionality and input handling

- The bill updates live: amounts, the CGST/SGST or IGST split, round-off, amount in words, Invoice Guard and suggestions all refresh on every keystroke. Rows are rebuilt only when one is added or removed, so focus is never lost while typing.
- **Incomplete input:** the save button is disabled until a product is chosen. An empty row with numbers typed in is flagged. Required fields show a message next to the field, which is also focused and marked with `aria-invalid`.
- **Invalid input:** each model class throws a `ValidationError` carrying a field name, so the UI knows which input to highlight. Covered cases include HSN length, GST rates outside the legal slabs, future invoice dates, non-integer quantities, a discount larger than the line amount, phone format, GSTIN format/state/checksum, a "From" date after the "To" date, duplicate product names, and duplicate customer GSTINs or phones.
- **Unexpected input:** a product deleted while it is on an open bill gets cleared from that row; there is a stock check across rows when the same product appears twice; restoring a backup that is the wrong type, too large, malformed JSON or the wrong version is refused with a clear message, and the current data is left untouched because every record is validated before any are replaced; a full or blocked `localStorage` turns the status dot red and tells the user to download a backup.
- **Safety:** all user text is escaped before it goes into HTML (to prevent XSS). Destructive actions ask for confirmation or offer Undo. A bill in progress survives a page refresh (stored in `sessionStorage`).
- **Accessibility and responsiveness:** semantic landmarks, a skip link, labelled inputs, `aria-live` status messages, a screen-reader table behind the chart, keyboard shortcuts, and a layout that works at 390px with no horizontal page scroll.

## 5. Asynchronous behaviour

**What must not block the UI:** checking a buyer's GSTIN with the GST portal. In practice that service is slow and sometimes unavailable, and the shopkeeper should be able to keep adding items while it runs. Loading the HSN rate master is a second async operation, and reading a backup file is a third.

Implementation ([js/services.js](js/services.js), [js/billing.js](js/billing.js)):

| Concern | Solution |
| :--- | :--- |
| Don't call the network for obviously bad input | Offline checksum first; an invalid GSTIN fails immediately with the expected check character |
| Don't fire a request per keystroke | 400 ms debounce |
| Stale responses | `AbortController`: each new keystroke aborts the previous request; results are also compared with the current input before display |
| A hung request | `withTimeout()`: 3 s, then the request is aborted |
| Temporary failures (HTTP 503) | `withRetry()`: 2 retries with exponential backoff plus jitter; user cancels and invalid input are never retried |
| Repeated lookups | response cache `Map` with a 10-minute TTL, plus an in-flight `Map` so two callers share one request |
| Final failure | the bill can still be issued (the checksum already passed); a warning is shown with a **Retry** button |
| HSN master can't load (`file://`, offline) | falls back to a built-in list; the app is usable before the fetch finishes |

**Evaluation.** The "Simulate GST portal outage" switch in Settings and the network log let you watch each path happen. The simulated portal has 0.5 to 1.6 s latency, about 12% 503 errors and about 5% hung requests. Measured in the browser test: a normal check finishes in about 1 to 1.5 s; a 503 recovers on retry after roughly 0.4 to 0.9 s of backoff; a full outage gives up after 3 attempts (about 3 to 4 s) and shows the fallback message. Typing during a check produced "request cancelled", and no stale result overwrote a newer one. The UI stayed responsive throughout, because nothing awaits on the main input path.

**Limitation:** the portal is simulated. The real GSTIN search API needs a GST Suvidha Provider (GSP) account. `mockPortal()` can be swapped for a `fetch()` to a backend proxy without changing the retry, timeout or cache code around it.

## 6. Intelligent enhancement: Invoice Guard

**What it is.** A rule engine ([js/guard.js](js/guard.js)) that re-checks the bill on every change and lists findings by severity. **Must fix** findings block saving; **Check** findings ask for confirmation; **Note** findings are information only. Some findings come with a one-click fix.

| Check | Severity |
| :--- | :--- |
| GSTIN checksum, format or state code wrong | Must fix |
| GSTIN *Cancelled* or *Suspended* on the portal | Must fix |
| Quantity more than stock (summed across rows) | Must fix |
| GSTIN state ≠ place of supply | Check, with a fix button |
| Rate differs from the HSN master | Check, with a fix button |
| A 12% or 28% slab used after GST 2.0 | Check |
| Quantity 8× or more above this product's median (likely 10 typed as 100) | Check |
| Same buyer and same amount within 30 minutes (double billing) | Check |
| Customer has bills unpaid for over 30 days | Check |
| Discount over 30% | Check |
| Inter-state supply, composition buyer, B2CL (inter-state B2C over ₹1 lakh), e-way bill over ₹50,000, stock dropping below reorder level | Note |

**Why it's needed.** An issued GST invoice can't be edited, only cancelled or corrected with a credit note, and errors flow into the buyer's input tax credit and the shop's GSTR-1. A shopkeeper at a busy counter is exactly the person who makes these mistakes and can least afford the paperwork that follows. Catching them before the bill exists is far cheaper than fixing them after filing. The anomaly checks learn from the shop's own history (median order size, co-purchase patterns) rather than fixed thresholds, so they get more useful the longer the app is used.

## 7. Critical evaluation of AI assistance

**Tool used:** Claude Code (Anthropic, Claude Opus 5.5) as a development assistant for planning, code generation and browser testing.

### Where the AI output was wrong or weak, and what was changed

| # | AI suggestion / output | Problem found | Change made |
| :- | :--- | :--- | :--- |
| 1 | Pulling the design from the reference site (atomato.co) | The AI could not load the site: TLS certificate verification failed, and the archive copy was blocked. The palette was reconstructed from memory, not measured. | All colours are tokens in `:root` in [styles.css](css/styles.css) so they can be retuned against the real site. *(Student: compare with the live site and adjust.)* |
| 2 | `Product` constructor guessed whether `price` was rupees or paise (`price > 999` → paise) | A heuristic like this silently breaks for a ₹5 item stored as 500 paise | The constructor always takes paise; `Product.fromForm` converts rupees explicitly |
| 3 | Form conversion validated price before name | Submitting an empty product form said "Price is required" instead of "Name is required" (found in the headless-browser test) | Conversion now skips empty values, so the constructor reports errors in field order |
| 4 | Weekday bars used `<span>` with a percentage width | Inline elements ignore `width`, so the bars rendered empty (found from a screenshot) | `display: block` on the track and fill |
| 5 | GSTIN typed into the bill only changed place of supply | A GSTIN belonging to a saved customer didn't link that customer, so the bill went to an unlinked name | The GSTIN is looked up in the customers Map and the customer linked |
| 6 | Dialog close buttons inside `<form method="dialog">` | Pressing Enter in a field fired the first submit button, which was the **×** close button, so the form closed without saving | Close/Cancel are `type="button"`; Save is the only submit button |
| 7 | Splitting tax into CGST = SGST = round(tax / 2) (the usual AI default) | Two separately rounded halves can add up to 1 paisa more than the tax | CGST = round(tax/2), SGST = tax − CGST; tested in Node |
| 8 | GST rate slabs 0/5/12/18/28 (pre-2025 knowledge is common in AI output) | Out of date after GST 2.0 (22 Sep 2025): most goods moved to 5% or 18%, sin goods to 40% | Slabs updated; 12% and 28% kept only for older invoices, and Guard warns on new bills |
| 9 | ES modules (`import`/`export`) | Blocked on `file://`, so a double-clicked `index.html` would be blank | Classic scripts with one namespace |
| 10 | GSTIN validation by regex only | Accepts many typos | Base-36 checksum added (verified against generated test GSTINs) |

### Limitations of the AI assistant observed

- It states GST rules confidently. Several (B2CL threshold, e-way bill limit, item-wise rates after GST 2.0) **must be verified** against CBIC notifications. A disclaimer is shown in the app.
- It can't see the rendered page unless it is asked to test. Bugs 3 to 6 were only found because a headless-browser run with screenshots was requested.
- Its demo data and simulated portal are plausible but invented. They are fine for a demo and must not be presented as real taxpayer data.

### Justification of the final implementation

Plain JavaScript with classes, Maps and Sets keeps the course concepts visible instead of hiding them inside a framework. The paise-integer engine, invoice snapshots and all-or-nothing stock deduction come from the domain rules of GST invoicing rather than general coding taste. The async layer (timeout, retry, cancel, cache, fallback) is written as small reusable functions, so the simulated portal can be replaced by a real backend without touching the UI.

*(Student: add your own observations here. For example, note which AI suggestions you rejected or rewrote yourself, and what you would build next: multi-device sync through a backend, login, purchase invoices for input tax credit.)*
