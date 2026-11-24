import { readFileSync } from 'node:fs';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import pg from 'pg';
import type { Pool } from 'pg';

type Value = string | number | null;
export interface Query {
  all<T>(sql: string, ...params: Value[]): Promise<T[]>;
  run(sql: string, ...params: Value[]): Promise<number>;
}
export interface Store extends Query {
  postgres: boolean;
  transaction<T>(work: (query: Query) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function sqliteStore(db: DatabaseSync): Store {
  let tail = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>) {
    const result = tail.then(work);
    tail = result.then(() => {}, () => {});
    return result;
  }
  const query: Query = {
    all: async <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as T[],
    run: async (sql, ...params) => Number(db.prepare(sql).run(...params).changes),
  };
  return {
    postgres: false,
    all: (sql, ...params) => exclusive(() => query.all(sql, ...params)),
    run: (sql, ...params) => exclusive(() => query.run(sql, ...params)),
    transaction: work => exclusive(async () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(query);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }),
    close: () => exclusive(async () => { db.close(); }),
  };
}

export function postgresPool(connectionString: string, schema = 'odd_scoring') {
  if (!/^odd_scoring(?:_[a-z0-9]+)?$/.test(schema)) throw new Error('Invalid Postgres schema');
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid Postgres connection URI');
  }
  const supabase = url.hostname.endsWith('.supabase.com') || url.hostname.endsWith('.supabase.co');
  const caPath = process.env.DATABASE_CA_FILE ?? (supabase ? '.data/supabase-ca.crt' : undefined);
  const ca = process.env.DATABASE_CA_CERT ?? (caPath ? readFileSync(caPath, 'utf8') : undefined);
  if (supabase || ca) {
    for (const name of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) {
      url.searchParams.delete(name);
    }
  }
  const pool = new pg.Pool({
    connectionString: url.toString(),
    ssl: supabase || ca ? { ca, rejectUnauthorized: true } : undefined,
    max: 4,
    connectionTimeoutMillis: 10_000,
    onConnect: async client => { await client.query('SET search_path TO ' + schema + ', pg_catalog'); },
  });
  pool.on('error', (error: NodeJS.ErrnoException) =>
    console.error('Idle Postgres connection failed:', error.code ?? error.name));
  return pool;
}

function postgresSql(sql: string) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + ++i);
}

export function postgresStore(pool: Pool): Store {
  function query(connection: Pick<Pool, 'query'>): Query {
    return {
      all: async <T>(sql: string, ...params: Value[]) =>
        (await connection.query(postgresSql(sql), params)).rows as T[],
      run: async (sql, ...params) =>
        (await connection.query(postgresSql(sql), params)).rowCount ?? 0,
    };
  }
  return {
    ...query(pool),
    postgres: true,
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(query(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function first<T>(query: Query, sql: string, ...params: Value[]) {
  return (await query.all<T>(sql, ...params))[0];
}
