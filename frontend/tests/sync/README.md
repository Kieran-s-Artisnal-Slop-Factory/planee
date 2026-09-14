# Sync tests

```sh
npm run test:sync          # builds the frontend + backend, then runs everything
npm run test:sync:ui       # same, in Playwright's UI mode
```

## Why it is built this way

The expensive failure in a local-first app is not any one sync bug — it is a
test suite that cannot fail. "Two devices" implemented as one IndexedDB wiped
and re-pulled is a backup/restore round-trip in a costume: it can never test
two live databases converging, and it passes precisely because it never runs
the scenario that breaks.

Three things make a green run here mean something.

**Two real devices.** Each is a Playwright `BrowserContext` with its own
IndexedDB, localStorage, service worker and cache, both pointed at one real Go
server serving a production build — the code path you ship, service worker and
same-origin URL resolution included.

**A four-leg oracle.** Every convergence assertion compares device A, device B,
what the server *serves* (`/sync/pull`) and what the server *stored* (a direct
read of the sqlite file via `backend/cmd/dbdump`), type-exactly: `1` is not
`"1"`, `true` is not `1`, an absent key is not a null one, floats compare
exactly. Convergence alone is not enough, so field cases also check the value
the test *intended* — if a push erases a field, all four legs agree on the
erased value and only an intended-value check notices.

Plus two structural checks on every converged database: `assertInvariants`
(referential integrity, unique ids, one row per single-row table) and
`assertIsolatedDelta` — after a case changes one field of one row, the total
delta across every store must be exactly that change. Most real data loss shows
up in the isolation diff, not in the targeted assertion.

**A sabotage suite.** `sabotage.spec.ts` injects thirteen known faults and
requires the oracle to catch each one. `trust-gate.ts` fails the whole run if
that suite did not execute, so a filtered or accidentally-empty run is reported
`NOT TRUSTWORTHY` rather than green.

## Adding a case

- `helpers/schema.ts` is generated from your schema; regenerate it when the
  schema changes so `field-matrix.spec.ts` keeps covering every column.
- Drive mutations through the app's real code (`repoPut`, `repoPatch`,
  `repoSoftDelete` on the test hook) rather than raw IndexedDB writes, except
  when you are deliberately corrupting state.
- Never wrap an assertion in `try/catch` and never skip conditionally to get
  green. If a case is flaky, fix the determinism — `retries` is 0 on purpose.
