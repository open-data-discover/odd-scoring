import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Store } from './store.ts';

export type Pair = { sha: string; pool: 'detected' | 'random'; ordinal: number };

export function reviewKey(sqlitePath?: string) {
  const configured = process.env.CARD_SIGNING_KEY;
  if (configured) {
    if (!/^[a-f0-9]{64}$/i.test(configured)) throw new Error('CARD_SIGNING_KEY must be 64 hexadecimal characters');
    return Buffer.from(configured, 'hex');
  }
  if (!sqlitePath) throw new Error('CARD_SIGNING_KEY is required with Postgres');
  const path = sqlitePath + '.key';
  try {
    writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return readFileSync(path);
}

export function reviewTokens(key: Buffer) {
  const derive = (purpose: string) => createHmac('sha256', key).update(purpose).digest();
  const encryptionKey = derive('join-check/card/v1');
  const receiptKey = derive('join-check/receipt/v1');
  return {
    receipt(player: number, { sha, pool, ordinal }: Pair) {
      return createHmac('sha256', receiptKey).update(JSON.stringify([player, sha, pool, ordinal])).digest('hex');
    },
    issue(player: number, { sha, pool, ordinal }: Pair) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
      cipher.setAAD(Buffer.from(String(player)));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify({ sha, pool, ordinal })), cipher.final()]);
      return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString('base64url');
    },
    read(player: number, token: string): Pair | undefined {
      if (!/^[A-Za-z0-9_-]{38,512}$/.test(token)) return undefined;
      try {
        const bytes = Buffer.from(token, 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from(String(player)));
        decipher.setAuthTag(bytes.subarray(-16));
        const plaintext = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
        return JSON.parse(plaintext.toString('utf8')) as Pair;
      } catch {
        return undefined;
      }
    },
  };
}

export const reviewSchema = [
  `CREATE TABLE IF NOT EXISTS review_points (
    player integer NOT NULL REFERENCES players(id),
    receipt text NOT NULL,
    answered_at bigint NOT NULL,
    PRIMARY KEY (player, receipt)
  )`,
  `CREATE TABLE IF NOT EXISTS disagreements (
    player integer NOT NULL,
    receipt text NOT NULL,
    source_sha text NOT NULL,
    analyzed_at text NOT NULL,
    pool text NOT NULL,
    score double precision,
    left_column jsonb NOT NULL,
    right_column jsonb NOT NULL,
    answer integer NOT NULL CHECK ((pool = 'detected' AND answer = 0) OR (pool = 'random' AND answer = 1)),
    PRIMARY KEY (player, receipt),
    FOREIGN KEY (player, receipt) REFERENCES review_points(player, receipt)
  )`,
];

export async function prepareReviews(db: Store) {
  await db.transaction(async query => {
    if (db.postgres) await query.all("SELECT pg_advisory_xact_lock(hashtext('odd-scoring-migration'))");
    for (const sql of reviewSchema) await query.run(sql);
  });
}
