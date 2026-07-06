# EOD running log

One line per trading day, per [OPERATIONS.md §5](OPERATIONS.md): `date · net realized (% / qualitative) · decision-type mix · incidents · weird`. Two weeks of these lines is the agenda for the periodic review. Newest at top.

- **2026-07-06 (Mon)** · net **negative** (margin red / cash green) · margin: 2× eod-stop on WEN (−12% bid, ≈ −22% on the 15-lot); cash: ENVX take-profit +21% & overnight-reduction +23% · **incident:** 23 dxLink session-limit restarts (new root cause, prime window clean, cache survived) · **weird:** whole day was WEN (18% spread, born pre-stopped); dip boost enabled but never fired (ask-blind). Full writeup: [plans/2026-07-06-monday-results.md](plans/2026-07-06-monday-results.md).
