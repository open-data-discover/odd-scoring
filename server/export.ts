import { once } from 'node:events';
import { openDb } from './db.ts';
import { postgresPool, sqliteStore } from './store.ts';
import { prepareReviews } from './reviews.ts';

const select = `
  SELECT c.source_sha, c.analyzed_at, c.pool AS source, c.score, c.player AS reviewer_id,
    c.answer, (c.pool = 'detected') AS predicted_join, r.answered_at, c.left_column, c.right_column
  FROM disagreements c
    JOIN review_points r ON r.player = c.player AND r.receipt = c.receipt
  ORDER BY r.answered_at, c.player, c.receipt
`;
type Row = Record<string, unknown>;

async function* rows(): AsyncGenerator<Row> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    const db = openDb();
    try {
      await prepareReviews(sqliteStore(db));
      yield* db.prepare(select).iterate();
    } finally {
      db.close();
    }
    return;
  }
  const pool = postgresPool(url, process.env.ODD_PG_SCHEMA);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('DECLARE audit_export CURSOR FOR ' + select);
      while (true) {
        const result = await client.query('FETCH 500 FROM audit_export');
        if (result.rows.length === 0) break;
        yield* result.rows;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

function column(json: unknown) {
  return typeof json === 'string' ? JSON.parse(json) : json;
}

for await (const { left_column, right_column, answer, predicted_join, answered_at, ...row } of rows()) {
    const line = JSON.stringify({
      ...row, answer: answer === 1, predicted_join: predicted_join === 1 || predicted_join === true,
      answered_at: new Date(Number(answered_at)).toISOString(),
      left: column(left_column), right: column(right_column),
    });
    if (!process.stdout.write(line + '\n')) await once(process.stdout, 'drain');
}
