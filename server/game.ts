import { createHash, randomBytes, randomInt } from 'node:crypto';
import { DateTime } from 'luxon';
import { first } from './store.ts';
import type { Query, Store } from './store.ts';
import { reviewTokens } from './reviews.ts';
import type { Pair } from './reviews.ts';

type Player = { id: number; name: string };
type Pool = Pair['pool'];
type Column = {
  id: number; dataset: string; title: string; file: string; resource: string;
  resource_id: string; name: string; samples: string | null; score: number | null; analyzed_at: string;
};
type Rank = { name: string; rank: number; points: number };
const zone = 'America/Toronto';
export const sessionAge = 365 * 24 * 60 * 60 * 1000;

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function game(db: Store, catalog: Query, sha: string, key: Buffer, now = Date.now, draw = randomInt,
  descriptions: ReadonlyMap<string, string> = new Map()) {
  const snapshotInfo = await first<{ pool_size: number }>(catalog, 'SELECT pool_size FROM imports WHERE sha = ?', sha);
  if (!snapshotInfo) throw new Error('Source snapshot has not been imported: ' + sha);
  const size = snapshotInfo.pool_size;
  const tokens = reviewTokens(key);
  const playerByKey = 'SELECT id, name FROM players WHERE name_key = ?';
  const playerBySession = `
    SELECT players.id, players.name FROM sessions JOIN players ON players.id = sessions.player
    WHERE hash = ? AND expires_at > ?
  `;
  const count = 'SELECT CAST(COUNT(*) AS INTEGER) AS points FROM review_points WHERE player = ?';
  const used = 'SELECT 1 FROM review_points WHERE player = ? AND receipt = ?';
  const cardColumns = `
    SELECT c.id, c.dataset, c.title, c.file, c.resource, c.resource_id, c.name, e.samples, p.score, i.analyzed_at
    FROM pairs p JOIN columns c ON c.sha = p.sha AND c.id IN (p.a, p.b)
    JOIN imports i ON i.sha = p.sha
    LEFT JOIN column_examples e ON e.sha = c.sha AND e.id = c.id
    WHERE p.sha = ? AND p.pool = ? AND p.ordinal = ?
    ORDER BY c.id
  `;
  async function points(player: Player, query: Query = db) {
    return (await first<{ points: number }>(query, count, player.id))!.points;
  }

  async function selectOrdinal(player: number, pool: Pool) {
    for (let i = 0; i < Math.min(size, 12); i++) {
      const ordinal = draw(size);
      if (!await first(db, used, player, tokens.receipt(player, { sha, pool, ordinal }))) return ordinal;
    }
    const completed = new Set((await db.all<{ receipt: string }>(
      'SELECT receipt FROM review_points WHERE player = ?', player,
    )).map(row => row.receipt));
    const start = draw(size);
    for (let i = 0; i < size; i++) {
      const ordinal = (start + i) % size;
      if (!completed.has(tokens.receipt(player, { sha, pool, ordinal }))) return ordinal;
    }
  }

  return {
    restore(token: string) {
      return first<Player>(db, playerBySession, tokenHash(token), now());
    },
    select(name: string, joinExisting: boolean) {
      return db.transaction(async query => {
        const key = name.toLowerCase();
        let player = await first<Player>(query, playerByKey, key);
        if (!player) {
          const created = await first<Player>(query, `
            INSERT INTO players (name, name_key) VALUES (?, ?)
            ON CONFLICT (name_key) DO NOTHING RETURNING id, name
          `, name, key);
          player = created ?? (joinExisting ? await first<Player>(query, playerByKey, key) : undefined);
        } else if (!joinExisting) {
          return undefined;
        }
        if (!player) return undefined;
        const token = randomBytes(32).toString('hex');
        await query.run('DELETE FROM sessions WHERE expires_at <= ?', now());
        await query.run('INSERT INTO sessions VALUES (?, ?, ?)', tokenHash(token), player.id, now() + sessionAge);
        return { player, token };
      });
    },
    points,
    async next(player: Player) {
      let pool: Pool = draw(4) < 3 ? 'detected' : 'random';
      let ordinal = await selectOrdinal(player.id, pool);
      if (ordinal === undefined) {
        pool = pool === 'detected' ? 'random' : 'detected';
        ordinal = await selectOrdinal(player.id, pool);
      }
      if (ordinal === undefined) return null;
      const columns = (await catalog.all<Column>(cardColumns, sha, pool, ordinal)).map(col => ({
        name: col.name,
        file: col.file,
        resource: col.resource,
        dataset: col.title,
        description: descriptions.get(col.dataset) ?? null,
        examples: col.samples ? JSON.parse(col.samples) as string[] : [],
        url: 'https://open.toronto.ca/dataset/' + encodeURIComponent(col.dataset) + '/',
      }));
      // Present either column first independently of Parquet order.
      if (randomInt(2)) columns.reverse();
      return { id: tokens.issue(player.id, { sha, pool, ordinal }), columns };
    },
    answer(player: Player, id: string, answer: boolean) {
      const pair = tokens.read(player.id, id);
      if (!pair) return undefined;
      const receipt = tokens.receipt(player.id, pair);
      const predicted = pair.pool === 'detected';
      return db.transaction(async query => {
        const saved = await query.run(`
          INSERT INTO review_points VALUES (?, ?, ?) ON CONFLICT (player, receipt) DO NOTHING
        `, player.id, receipt, now());
        if (saved && answer !== predicted) {
          const columns = await catalog.all<Column>(cardColumns, pair.sha, pair.pool, pair.ordinal);
          if (columns.length !== 2) throw new Error('Review pair is no longer available');
          const { score, analyzed_at } = columns[0];
          const [left, right] = columns.map(({ samples: _samples, score: _score, analyzed_at: _date, ...column }) =>
            JSON.stringify(column));
          await query.run('INSERT INTO disagreements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            player.id, receipt, pair.sha, analyzed_at, pair.pool, score, left, right, Number(answer));
        }
        const prior = saved ? undefined : await first<{ answer: number }>(query,
          'SELECT answer FROM disagreements WHERE player = ? AND receipt = ?', player.id, receipt);
        return { points: await points(player, query), answer: saved ? answer : prior ? prior.answer === 1 : predicted };
      });
    },
    async leaderboard(player?: Player) {
      const cutoff = DateTime.fromMillis(now(), { zone }).startOf('day').toMillis();
      const entries = await db.all<Rank & { player: number; position: number }>(`
        WITH totals AS (
          SELECT player, CAST(COUNT(*) AS INTEGER) AS points
          FROM review_points WHERE answered_at < ? GROUP BY player
        ), ranked AS (
          SELECT name, player, points,
            CAST(RANK() OVER (ORDER BY points DESC) AS INTEGER) AS rank,
            CAST(ROW_NUMBER() OVER (ORDER BY points DESC, name_key) AS INTEGER) AS position
          FROM totals JOIN players ON players.id = player
        )
        SELECT name, player, points, rank, position FROM ranked
        WHERE position <= 50 OR player = ? ORDER BY position
      `, cutoff, player?.id ?? null);
      const top = entries.filter(entry => entry.position <= 50).map(({ name, rank, points }) =>
        ({ name, rank, points }));
      const rank = entries.find(entry => entry.player === player?.id);
      return {
        asOf: new Date(cutoff).toISOString(),
        top,
        you: player ? { name: player.name, rank: rank?.rank ?? null, points: rank?.points ?? 0,
          livePoints: await points(player) } : null,
      };
    },
  };
}
