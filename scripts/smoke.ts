import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { sourceSha } from '../server/data.ts';
import { openCatalog, openDb } from '../server/db.ts';
import { game } from '../server/game.ts';
import { sqliteStore } from '../server/store.ts';
import { prepareReviews, reviewTokens } from '../server/reviews.ts';

const temporary = mkdtempSync(join(tmpdir(), 'odd-scoring-'));
const dbFile = join(temporary, 'acceptance.sqlite');
const catalogFile = join(temporary, 'catalog.sqlite');
const socket = createServer().listen(0, '127.0.0.1');
await once(socket, 'listening');
const address = socket.address();
assert(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>(resolve => socket.close(() => resolve()));
const base = 'http://127.0.0.1:' + port;
const key = Buffer.alloc(32, 37);
const tokens = reviewTokens(key);
const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: '', ODD_DB: dbFile, ODD_CATALOG_DB: catalogFile,
  CARD_SIGNING_KEY: key.toString('hex'), PORT: String(port) };
let child: ReturnType<typeof spawn> | undefined;

async function start() {
  child = spawn(process.execPath, ['server/index.ts'], { env, stdio: 'inherit' });
  for (let i = 0; i < 300; i++) {
    const response = await fetch(base + '/api/health').catch(() => null);
    if (response?.ok) return;
    assert.equal(child.exitCode, null, 'Server exited before becoming ready');
    await setTimeout(100);
  }
  throw new Error('Server did not become ready');
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

function request(endpoint: string, cookie?: string, body?: object) {
  return fetch(base + '/api/' + endpoint, {
    method: body ? 'POST' : 'GET',
    headers: { ...(cookie && { Cookie: cookie }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
}

function sessionCookie(response: Response) {
  const header = response.headers.get('set-cookie');
  assert(header && header.includes('HttpOnly') && header.includes('SameSite=Lax'));
  return header.split(';', 1)[0];
}

function prediction(cardId: string) {
  const pair = tokens.read(1, cardId);
  assert(pair);
  return pair.pool === 'detected';
}

async function checkSampling() {
  const db = openDb(':memory:');
  const catalog = openCatalog(':memory:');
  try {
    catalog.exec(`
      INSERT INTO imports VALUES ('test', 'date', 1);
      INSERT INTO columns VALUES
        ('test', 0, 'a', 'A', 'a.csv', 'A', 'a', 'A'),
        ('test', 1, 'b', 'B', 'b.csv', 'B', 'b', 'B'),
        ('test', 2, 'c', 'C', 'c.csv', 'C', 'c', 'C');
      INSERT INTO pairs VALUES ('test', 'detected', 0, 0, 1, 0.2), ('test', 'random', 0, 0, 2, NULL);
    `);
    const before = Date.parse('2026-11-01T03:59:00Z');
    let now = before;
    let roll = 0;
    const store = sqliteStore(db);
    await prepareReviews(store);
    const play = await game(store, sqliteStore(catalog), 'test', key, () => now, max => max === 4 ? roll : 0);
    const first = (await play.select('first', false))!.player;
    const second = (await play.select('second', false))!.player;
    for (roll = 0; roll < 4; roll++) {
      const user = (await play.select('sample-' + roll, false))!.player;
      const card = (await play.next(user))!;
      assert(card.columns.some(column => column.name === (roll === 3 ? 'C' : 'B')));
    }
    roll = 0;
    for (const user of [first, second]) {
      const card = (await play.next(user))!;
      assert(card.columns.some(column => column.name === 'B'));
      assert.equal((await play.answer(user, card.id, true))?.points, 1);
    }
    now = Date.parse('2026-11-01T06:30:00Z');
    assert.equal((await play.leaderboard(first)).asOf, new Date(now).toISOString());
    assert.deepEqual((await play.leaderboard()).top.map(row => row.rank), [1, 1]);
    const fallback = (await play.next(first))!;
    assert(fallback.columns.some(column => column.name === 'C'));
    assert.equal((await play.answer(first, fallback.id, false))?.points, 2);
    assert.equal(await play.next(first), null);
    assert.deepEqual((await play.leaderboard()).top.map(row => row.rank), [1, 2]);
    assert.equal((await play.leaderboard(first)).you?.points, 2);
  } finally {
    db.close();
    catalog.close();
  }
}

try {
  await checkSampling();
  await start();
  assert.match(await (await fetch(base)).text(), /Join Check/);
  const db = openCatalog(catalogFile);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM columns').get()?.n, 9334);
  for (const pool of ['detected', 'random']) {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pairs WHERE pool = ?').get(pool)?.n, 264621);
  }
  assert(db.prepare("SELECT 1 FROM pairs WHERE pool = 'detected' AND score < .3").get());
  assert.equal(db.prepare('SELECT 1 FROM pairs GROUP BY sha, a, b HAVING COUNT(*) > 1').get(), undefined);
  db.close();

  assert.equal(await (await request('session')).json(), null);
  assert.equal((await request('card')).status, 401);
  const first = await request('session', undefined, { name: '  Audit fan  ' });
  assert.deepEqual(await first.json(), { name: 'Audit fan', points: 0 });
  const cookie = sessionCookie(first);
  const taken = await request('session', undefined, { name: 'AUDIT FAN' });
  assert.equal(taken.status, 409);
  assert.equal(taken.headers.get('set-cookie'), null);
  const second = await request('session', undefined, { name: 'AUDIT FAN', joinExisting: true });
  const secondCookie = sessionCookie(second);
  assert.notEqual(cookie, secondCookie);

  const card = await (await request('card', cookie)).json();
  assert.deepEqual(Object.keys(card).sort(), ['columns', 'id']);
  assert.equal(card.columns.length, 2);
  for (const column of card.columns) {
    assert.deepEqual(Object.keys(column).sort(),
      ['dataset', 'description', 'examples', 'file', 'name', 'resource', 'url']);
    assert(column.examples.length > 0 && column.examples.length <= 3);
    assert(column.examples.every((value: unknown) => typeof value === 'string'));
    assert(column.description === null || typeof column.description === 'string');
    assert.match(column.url, /^https:\/\/open\.toronto\.ca\/dataset\/[^/]+\/$/);
  }
  const otherCard = await (await request('card', secondCookie)).json();
  assert.notEqual(otherCard.id, card.id);
  const unopened = openDb(dbFile);
  assert.equal(unopened.prepare('SELECT COUNT(*) AS n FROM review_points').get()?.n, 0);
  assert.equal(unopened.prepare('SELECT COUNT(*) AS n FROM disagreements').get()?.n, 0);
  assert.equal(unopened.prepare("SELECT name FROM sqlite_master WHERE name = 'cards'").get(), undefined);
  assert.equal(unopened.prepare("SELECT name FROM sqlite_master WHERE name = 'pairs'").get(), undefined);
  unopened.close();

  const save = { cardId: card.id, answer: prediction(card.id) };
  const tampered = (card.id.startsWith('A') ? 'B' : 'A') + card.id.slice(1);
  assert.equal((await request('answer', cookie, { ...save, cardId: tampered })).status, 404);
  const samePair = tokens.issue(1, tokens.read(1, card.id)!);
  const attempts = await Promise.all([
    request('answer', cookie, save),
    request('answer', secondCookie, { ...save, cardId: samePair }),
  ]);
  for (const attempt of attempts) assert.deepEqual(await attempt.json(), { answer: save.answer, points: 1 });
  const next = await (await request('card', secondCookie)).json();
  assert.notEqual(next.id, card.id);
  const disagreement = { cardId: next.id, answer: !prediction(next.id) };
  assert.equal((await (await request('answer', secondCookie, disagreement)).json()).points, 2);
  const board = await (await request('leaderboard', cookie)).json();
  assert.deepEqual(board.you, { name: 'Audit fan', rank: 1, points: 2, livePoints: 2 });

  await stop();
  const recorded = openDb(dbFile);
  assert.equal(recorded.prepare('SELECT COUNT(*) AS n FROM review_points').get()?.n, 2);
  assert.equal(recorded.prepare('SELECT COUNT(*) AS n FROM disagreements').get()?.n, 1);
  recorded.close();
  await start();
  assert.deepEqual(await (await request('session', cookie)).json(), { name: 'Audit fan', points: 2 });
  const rows = execFileSync(process.execPath, ['server/export.ts'], { env, encoding: 'utf8' })
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].answer, disagreement.answer);
  assert.equal(rows[0].predicted_join, !disagreement.answer);
  assert(rows.every(row => row.source_sha === sourceSha && typeof row.answer === 'boolean'
    && row.analyzed_at && row.left.resource_id && row.right.resource_id));
  console.log('Passed full-snapshot, sampling, HTTP voting, live rankings and restart/export smoke checks.');
} finally {
  await stop();
  rmSync(temporary, { force: true, recursive: true });
}
