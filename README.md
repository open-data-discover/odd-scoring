# Join Check

Join Check collects human judgments on whether two Toronto Open Data columns
represent the same thing. Each answer earns one point for the selected username.
The leaderboard ranks all saved answers and refreshes when new votes are saved.
Cards show sample values from the pinned analysis and dataset descriptions
from the City of Toronto’s catalog when available.

## Run locally

Use Node 24 and run the following in this repository.

```sh
npm ci
npm run data
npm run build
npm start
```

Open http://localhost:3000. With `DATABASE_URL` in the ignored `.env` file,
the app uses Postgres. Place the Supabase database CA certificate in
`.data/supabase-ca.crt`, or set `DATABASE_CA_FILE` to its path. Set
`CARD_SIGNING_KEY` to a stable 32-byte random key encoded as 64 hex characters.
Keep this key with the database so duplicate-vote protection survives redeploys.
The source data is cached in `.data/catalog.sqlite`. Without the URL, the app
keeps local gameplay data in `.data/join-check.sqlite`. For
frontend development, run `npm run server` and `npm run dev` in separate terminals.

`npm run smoke` exercises the built app against the real catalog with a
temporary database, including a server restart. Its row-count assertions track
the pinned snapshot.

## Update the source data

Change `sourceSha` in `server/data.ts` to the Open Data Discover commit
that contains the new artifacts, then rerun `npm run data` and restart. The
data command fetches the three artifacts from that SHA and refreshes the
dataset description cache. To read the artifacts from a local
upstream checkout, use `npm run data -- /path/to/open-data-discover`.
On startup the local server rebuilds its catalog from the pinned data if necessary.
For GitHub Pages, rerun `npm run publish:data` after changing the pin to load
the new catalog into Supabase. Disagreements retain their original source details.

## Supabase setup

Use the Supabase **Session pooler** connection URI and the project's CA
certificate. Run `npm run setup:db` once to create the private `odd_scoring`
schema. `players` and `sessions` record usernames and
sign-ins. `review_points` records completions. `disagreements` records the
pairs and answers that differed from the prediction. Supabase Realtime notifies
open leaderboards when a vote earns a new review point.

## Publish on GitHub Pages

The Pages workflow publishes the frontend at
https://open-data-discover.github.io/odd-scoring/. The browser calls Supabase
directly through a database function. Run `npm run publish:data` after
setting up the database and fetching the source files. This installs the
function and imports two private catalog tables in addition to the gameplay tables.
It stores the card key in Vault.

Enable GitHub Actions as the Pages source in the repository settings. Set
`ODD_SCORING_SUPABASE_URL` and `ODD_SCORING_SUPABASE_KEY` as repository Actions
variables using the project origin and public publishable key. The workflow
checks the Supabase leaderboard endpoint before deploying the frontend.

## Export disagreements

From a private shell on the service, run `npm run --silent export` to stream
one JSON object per disagreement. The command uses Postgres when `DATABASE_URL`
is set and the local SQLite file otherwise. Each
record includes the upstream SHA, both columns, the sampling pool, the
detector score when available, a reviewer ID, the prediction, the answer, and its
timestamp. A **No** on a detected pair or a **Yes** on a random pair counts as a
disagreement. All detected candidates count as predicted joins, including those
below the Open Data Discover display cutoff.

Showing a card does not create a database row. A completed vote earns one point
in `review_points`, which stores the reviewer, completion time, and an opaque
deduplication receipt. Only `disagreements` stores the pair and explicit vote.
