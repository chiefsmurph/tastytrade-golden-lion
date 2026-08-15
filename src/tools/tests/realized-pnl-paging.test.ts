import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOrderSourceIndex,
  buildRealizedPnlReport,
  fetchAllPages,
  formatRealizedPnlReport,
  LEDGER_MAX_PAGES,
  readLedgerPage,
  rowIdentity,
  summarizeFetch,
  type LedgerPage,
} from "../realized-pnl-report";

// REGRESSION — 2026-08-15. The tool issued ONE unpaged request. The transactions
// endpoint is paginated and caps a page at 250 rows, so every window longer than
// that was silently truncated — roughly a quarter of the history dropped, and
// biased WORSE the longer the window, which is the opposite of what a reader
// assumes. Nothing in the output distinguished a truncated read from a complete
// one, so numbers taken from it were confidently wrong.
//
// Two properties matter more than the paging itself and are pinned below:
//   1. a partial fetch must be impossible to mistake for a whole one;
//   2. paging must never DOUBLE-COUNT. The paging params cannot be verified
//      offline, and an API that ignores an unknown param serves page 1 forever;
//      a loop that trusted the offset would report a doubled P&L.
//
// No clock is read in this path, so no test-clock fixture is needed.

const page = (over: Partial<LedgerPage> = {}): LedgerPage => ({
  items: [],
  totalItems: null,
  totalPages: null,
  perPage: null,
  pageOffset: null,
  ...over,
});

// ── Response-shape parsing ──────────────────────────────────────────────────
test("readLedgerPage handles all three shapes the same call can arrive in", () => {
  // 1. SDK service result: a bare array, pagination already discarded.
  const bare = readLedgerPage([{ id: "1" }, { id: "2" }]);
  assert.equal(bare.items.length, 2);
  assert.equal(bare.totalItems, null, "the SDK strips pagination; do not invent it");

  // 2. Raw response body: items nested under `data`, pagination alongside.
  const body = readLedgerPage({
    data: { items: [{ id: "1" }] },
    pagination: { "per-page": 250, "page-offset": 0, "total-items": 447, "total-pages": 2 },
  });
  assert.equal(body.items.length, 1);
  assert.equal(body.totalItems, 447);
  assert.equal(body.totalPages, 2);
  assert.equal(body.perPage, 250);
  assert.equal(body.pageOffset, 0);

  // 3. Full axios response, identified by `status`.
  const axiosLike = readLedgerPage({
    status: 200,
    data: { data: { items: [{ id: "1" }, { id: "2" }] }, pagination: { "total-items": 2 } },
  });
  assert.equal(axiosLike.items.length, 2);
  assert.equal(axiosLike.totalItems, 2);
});

test("readLedgerPage reads camelCase pagination and degrades to empty, never throws", () => {
  const camel = readLedgerPage({
    items: [{ id: "1" }],
    pagination: { totalItems: 10, totalPages: 4, perPage: 250, pageOffset: 1 },
  });
  assert.equal(camel.totalItems, 10);
  assert.equal(camel.totalPages, 4);
  assert.equal(camel.perPage, 250);
  assert.equal(camel.pageOffset, 1);

  for (const junk of [null, undefined, 42, "nope", {}, { data: null }]) {
    const parsed = readLedgerPage(junk);
    assert.deepEqual(parsed.items, [], `${JSON.stringify(junk)} must read as zero rows`);
    assert.equal(parsed.totalItems, null);
  }
});

// ── The double-count guard ──────────────────────────────────────────────────
test("rowIdentity is stable per row and distinct across rows", () => {
  const row = { id: "9001", symbol: "RUM", "executed-at": "2026-08-12T14:30:00Z" };
  assert.equal(rowIdentity(row, 0), rowIdentity(row, 7), "identity must not depend on position");
  assert.notEqual(rowIdentity(row, 0), rowIdentity({ ...row, id: "9002" }, 0));
});

test("rowIdentity falls back to content when the row carries no id", () => {
  const a = {
    "executed-at": "2026-08-12T14:30:00Z",
    symbol: "RUM",
    "transaction-sub-type": "Buy to Open",
    "net-value": 202,
  };
  assert.equal(rowIdentity(a, 0), rowIdentity({ ...a }, 3), "same content = same identity");
  assert.notEqual(rowIdentity(a, 0), rowIdentity({ ...a, "net-value": 203 }, 0));
  // A row with nothing usable still gets a unique identity rather than colliding.
  assert.notEqual(rowIdentity({}, 0), rowIdentity({}, 1));
});

// ── Completeness verdicts ───────────────────────────────────────────────────
test("a fully-read window is COMPLETE", () => {
  const audit = summarizeFetch({
    pages: [page({ items: [1, 2], totalItems: 2, totalPages: 1, perPage: 250 })],
    rowsFetched: 2,
    pageCap: 40,
  });
  assert.equal(audit.incomplete, false);
  assert.equal(audit.reason, null);
  assert.equal(audit.rowsFetched, 2);
  assert.equal(audit.reportedTotalItems, 2);
});

test("fetching fewer rows than the API says exist is INCOMPLETE", () => {
  // The exact shipped failure: one page of 250 out of 447.
  const audit = summarizeFetch({
    pages: [page({ items: new Array(250).fill(0), totalItems: 447, perPage: 250 })],
    rowsFetched: 250,
    pageCap: 40,
  });
  assert.equal(audit.incomplete, true);
  assert.match(audit.reason ?? "", /447 rows available/);
});

test("a stalled page, a mid-window error, and the page cap are all INCOMPLETE", () => {
  const stalled = summarizeFetch({ pages: [page(), page()], rowsFetched: 250, pageCap: 40, stalled: true });
  assert.equal(stalled.incomplete, true);
  assert.match(stalled.reason ?? "", /ignoring the paging params/);

  const failed = summarizeFetch({ pages: [page()], rowsFetched: 10, pageCap: 40, error: "boom" });
  assert.equal(failed.incomplete, true);
  assert.match(failed.reason ?? "", /boom/);

  const capped = summarizeFetch({
    pages: new Array(40).fill(null).map(() => page({ items: [1] })),
    rowsFetched: 40,
    pageCap: 40,
  });
  assert.equal(capped.incomplete, true);
  assert.match(capped.reason ?? "", /safety cap/);
});

test("no pagination metadata is not treated as proof of completeness OR failure", () => {
  // The SDK strips the envelope, so a clean short-page stop is all we get.
  const audit = summarizeFetch({ pages: [page({ items: [1, 2, 3] })], rowsFetched: 3, pageCap: 40 });
  assert.equal(audit.reportedTotalItems, null);
  assert.equal(audit.incomplete, false, "a clean short page is a legitimate end of window");
});

// ── The printed verdict ─────────────────────────────────────────────────────
const OPEN_ROW = {
  symbol: "RUM   260821C00009000",
  "underlying-symbol": "RUM",
  "instrument-type": "Equity Option",
  "transaction-sub-type": "Buy to Open",
  quantity: 1,
  value: 100,
  "value-effect": "Debit",
  "net-value": 101,
  "net-value-effect": "Debit",
  "executed-at": "2026-08-12T14:30:00Z",
};

test("a truncated window is shouted about, not quietly printed", () => {
  const lines = formatRealizedPnlReport(
    buildRealizedPnlReport([OPEN_ROW], {
      fetchAudit: {
        rowsFetched: 250,
        pagesFetched: 1,
        reportedTotalItems: 447,
        perPage: 250,
        incomplete: true,
        reason: "API reports 447 rows available",
      },
    }),
  ).join("\n");

  assert.match(lines, /TRUNCATED LEDGER/);
  assert.match(lines, /INCOMPLETE/);
  assert.match(lines, /250 rows over 1 page/);
  assert.match(lines, /447/);
});

test("a complete window says so explicitly, so the loud line means something", () => {
  const lines = formatRealizedPnlReport(
    buildRealizedPnlReport([OPEN_ROW], {
      fetchAudit: {
        rowsFetched: 12,
        pagesFetched: 1,
        reportedTotalItems: 12,
        perPage: 250,
        incomplete: false,
        reason: null,
      },
    }),
  ).join("\n");

  assert.match(lines, /ledger fetch: 12 rows over 1 page\(s\) of 250/);
  assert.match(lines, /COMPLETE/);
  assert.doesNotMatch(lines, /TRUNCATED/);
});

test("a caller that supplies no audit at all is flagged, not assumed complete", () => {
  const lines = formatRealizedPnlReport(buildRealizedPnlReport([OPEN_ROW])).join("\n");
  assert.match(lines, /LEDGER COMPLETENESS UNKNOWN/);
  assert.equal(buildRealizedPnlReport([OPEN_ROW]).fetchAudit, null);
});

// ── The paging loop ─────────────────────────────────────────────────────────
const PER_PAGE = 250;

/** A page of distinct rows, ids continuing from `start`. */
const rowsFrom = (start: number, count: number) =>
  Array.from({ length: count }, (_unused, i) => ({ id: String(start + i) }));

test("paging walks past the 250-row cap and returns the whole window", () => {
  // The shipped bug in one assertion: one request returned 250 of 447.
  const served: Record<number, unknown> = {
    0: { data: { items: rowsFrom(0, PER_PAGE) }, pagination: { "total-items": 447, "total-pages": 2 } },
    1: { data: { items: rowsFrom(PER_PAGE, 197) }, pagination: { "total-items": 447, "total-pages": 2 } },
  };
  return fetchAllPages(async (params) => served[Number(params["page-offset"])] ?? { data: { items: [] } })
    .then(({ rows, audit }) => {
      assert.equal(rows.length, 447, "the tail must not be dropped");
      assert.equal(audit.pagesFetched, 2);
      assert.equal(audit.incomplete, false);
      assert.equal(audit.reportedTotalItems, 447);
    });
});

test("paging asks for the max page size and advances the offset", () => {
  const seenParams: Record<string, unknown>[] = [];
  return fetchAllPages(async (params) => {
    seenParams.push(params);
    return { data: { items: seenParams.length === 1 ? rowsFrom(0, PER_PAGE) : rowsFrom(PER_PAGE, 3) } };
  }).then(() => {
    assert.equal(seenParams.length, 2);
    assert.equal(seenParams[0]!["per-page"], PER_PAGE);
    assert.equal(seenParams[0]!["page-offset"], 0);
    assert.equal(seenParams[1]!["page-offset"], 1, "the offset must actually advance");
  });
});

test("an API that IGNORES the paging params can never double-count", () => {
  // The scenario that makes a naive loop dangerous: every offset serves page 1.
  // Concatenating blindly would report 250 → 10,000 rows and a P&L to match.
  const firstPage = rowsFrom(0, PER_PAGE);
  return fetchAllPages(async () => ({ data: { items: firstPage } })).then(({ rows, audit }) => {
    assert.equal(rows.length, PER_PAGE, "each row appears exactly once");
    assert.equal(new Set(rows.map((r) => (r as { id: string }).id)).size, PER_PAGE);
    assert.equal(audit.incomplete, true, "and we must SAY we could not finish");
    assert.match(audit.reason ?? "", /ignoring the paging params/);
  });
});

test("a short first page ends the walk in a single request", () => {
  let calls = 0;
  return fetchAllPages(async () => {
    calls += 1;
    return rowsFrom(0, 12); // bare array: the SDK shape, no pagination
  }).then(({ rows, audit }) => {
    assert.equal(calls, 1, "a short page is the end of the window");
    assert.equal(rows.length, 12);
    assert.equal(audit.incomplete, false);
  });
});

test("an exactly-full final page costs one extra empty request, then stops cleanly", () => {
  // Without pagination metadata a full page is indistinguishable from a partial
  // window, so the loop must probe once more rather than guess.
  let calls = 0;
  return fetchAllPages(async (params) => {
    calls += 1;
    return Number(params["page-offset"]) === 0 ? rowsFrom(0, PER_PAGE) : [];
  }).then(({ rows, audit }) => {
    assert.equal(calls, 2);
    assert.equal(rows.length, PER_PAGE);
    assert.equal(audit.incomplete, false, "an empty follow-up page proves the end");
  });
});

test("a mid-window failure keeps the rows it has and marks them incomplete", () => {
  return fetchAllPages(async (params) => {
    if (Number(params["page-offset"]) === 1) throw new Error("502 upstream");
    return rowsFrom(0, PER_PAGE);
  }).then(({ rows, audit }) => {
    assert.equal(rows.length, PER_PAGE, "partial data is kept…");
    assert.equal(audit.incomplete, true, "…but never presented as whole");
    assert.match(audit.reason ?? "", /502 upstream/);
  });
});

test("the loop cannot run away", () => {
  let calls = 0;
  return fetchAllPages(async (params) => {
    calls += 1;
    // Always full, always new rows, never any pagination metadata.
    return rowsFrom(Number(params["page-offset"]) * PER_PAGE, PER_PAGE);
  }).then(({ audit }) => {
    assert.equal(calls, LEDGER_MAX_PAGES);
    assert.equal(audit.pagesFetched, LEDGER_MAX_PAGES);
    assert.equal(audit.incomplete, true);
    assert.match(audit.reason ?? "", /safety cap/);
  });
});

// ── Order-source index ──────────────────────────────────────────────────────
test("buildOrderSourceIndex keeps only usable id/source pairs", () => {
  const index = buildOrderSourceIndex([
    { id: 495123886, source: "tastytrade-silver-lynx" },
    { id: "495123887", source: "  tastytrade-golden-lion-spray-buy  " },
    { id: "495123888" }, // no source
    { source: "tastytrade-silver-lynx" }, // no id
    null,
    "nonsense",
  ]);

  assert.equal(index.size, 2);
  assert.equal(index.get("495123886"), "tastytrade-silver-lynx");
  assert.equal(index.get("495123887"), "tastytrade-golden-lion-spray-buy", "trimmed");
  assert.equal(index.get("495123888"), undefined);
  assert.deepEqual(buildOrderSourceIndex([]), new Map());
});
