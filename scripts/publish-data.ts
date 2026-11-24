import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { openCatalog } from '../server/db.ts';
import { descriptionsPath, sourceSha } from '../server/data.ts';
import { importExamples, importSnapshot } from '../server/import.ts';
import { postgresPool } from '../server/store.ts';

const url = process.env.DATABASE_URL;
const key = process.env.CARD_SIGNING_KEY;
if (!url || !key || !/^[a-f0-9]{64}$/i.test(key)) {
  throw new Error('DATABASE_URL and CARD_SIGNING_KEY are required');
}
const catalog = openCatalog();
const pool = postgresPool(url);

async function insertBatches(client: PoolClient, sql: string, rows: Iterable<object>) {
  let batch: object[] = [];
  for (const row of rows) {
    batch.push(row);
    if (batch.length === 4000) {
      await client.query(sql, [JSON.stringify(batch)]);
      batch = [];
    }
  }
  if (batch.length) await client.query(sql, [JSON.stringify(batch)]);
}

try {
  await importSnapshot(catalog);
  await importExamples(catalog);
  const descriptions = await readFile(descriptionsPath, 'utf8').then(
    text => new Map<string, string>(Object.entries(JSON.parse(text))),
    error => {
      if (error.code !== 'ENOENT') throw error;
      return new Map<string, string>();
    },
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'; SET LOCAL idle_in_transaction_session_timeout = '2min'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('odd-scoring-migration'))");
    await client.query(await readFile(new URL('../server/pages.sql', import.meta.url), 'utf8'));
    const secret = (await client.query(
      "SELECT id, decrypted_secret FROM vault.decrypted_secrets WHERE name = 'odd_scoring_card_key'",
    )).rows[0];
    if (!secret) {
      await client.query("SELECT vault.create_secret($1, 'odd_scoring_card_key')", [key.toLowerCase()]);
    } else if (secret.decrypted_secret !== key.toLowerCase()) {
      await client.query('SELECT vault.update_secret($1, $2)', [secret.id, key.toLowerCase()]);
    }
    const sizes = await client.query(`
      SELECT (SELECT count(*) FROM odd_scoring.catalog_columns WHERE sha = $1) AS columns,
        (SELECT count(*) FROM odd_scoring.catalog_pairs WHERE sha = $1) AS pairs
    `, [sourceSha]);
    const localColumns = Number(catalog.prepare('SELECT count(*) AS n FROM columns WHERE sha = ?').get(sourceSha)!.n);
    const localPairs = Number(catalog.prepare('SELECT count(*) AS n FROM pairs WHERE sha = ?').get(sourceSha)!.n);
    const { columns, pairs } = sizes.rows[0];
    if (Number(columns) === 0 && Number(pairs) === 0) {
      console.log('Uploading the pinned catalog to Supabase…');
      function* columnRows() {
        for (const c of catalog.prepare(`
          SELECT c.*, i.analyzed_at, e.samples FROM columns c JOIN imports i ON i.sha = c.sha
          LEFT JOIN column_examples e ON e.sha = c.sha AND e.id = c.id WHERE c.sha = ?
        `).iterate(sourceSha)) {
          const slug = String(c.dataset);
          yield { sha: sourceSha, id: Number(c.id), analyzed_at: String(c.analyzed_at), details: {
            package: slug, dataset: c.title, file: c.file, resource: c.resource,
            resource_id: c.resource_id, name: c.name, description: descriptions.get(slug) ?? null,
            examples: c.samples ? JSON.parse(String(c.samples)) : [],
            url: 'https://open.toronto.ca/dataset/' + encodeURIComponent(slug) + '/',
          } };
        }
      }
      function* pairRows() {
        for (const row of catalog.prepare('SELECT sha, pool, ordinal, a, b, score FROM pairs WHERE sha = ?')
          .iterate(sourceSha)) {
          yield row;
        }
      }
      await insertBatches(client, `
        INSERT INTO odd_scoring.catalog_columns SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS x(sha text, id integer, analyzed_at text, details jsonb)
      `, columnRows());
      await insertBatches(client, `
        INSERT INTO odd_scoring.catalog_pairs SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS x(sha text, pool text, ordinal integer, a integer, b integer, score double precision)
      `, pairRows());
    }
    const verified = (await client.query(`
      SELECT (SELECT count(*) FROM odd_scoring.catalog_columns WHERE sha = $1) AS columns,
        (SELECT count(*) FROM odd_scoring.catalog_pairs WHERE sha = $1) AS pairs
    `, [sourceSha])).rows[0];
    if (Number(verified.columns) !== localColumns || Number(verified.pairs) !== localPairs) {
      throw new Error('Supabase catalog row counts do not match the pinned local snapshot');
    }
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log('Published ' + localColumns + ' columns and ' + localPairs + ' pairs to the private catalog.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
} finally {
  catalog.close();
  await pool.end();
}
