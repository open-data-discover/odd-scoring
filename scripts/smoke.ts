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
      now += 2000;
      assert.deepEqual(await play.answer(user, card.id, true),
        { points: 6, answers: 1, earned: 6, answer: true, promotion: 1 });
    }
    now = Date.parse('2026-11-01T06:30:00Z');
    assert.equal((await play.leaderboard(first)).asOf, new Date(now).toISOString());
    assert.deepEqual((await play.leaderboard()).top.map(row => row.rank), [1, 1]);
    const fallback = (await play.next(first))!;
    assert(fallback.columns.some(column => column.name === 'C'));
    now += 2000;
    assert.deepEqual(await play.answer(first, fallback.id, false),
      { points: 12, answers: 2, earned: 6, answer: false, promotion: null });
    assert.equal(await play.next(first), null);
    assert.deepEqual((await play.leaderboard()).top.map(row => row.rank), [1, 2]);
    assert.equal((await play.leaderboard(first)).you?.points, 12);
    const movingUp = (await play.next(second))!;
    now += 2000;
    assert.deepEqual(await play.answer(second, movingUp.id, false),
      { points: 12, answers: 2, earned: 6, answer: false, promotion: 1 });
    for (let i = 0; i < 8; i++) {
      const { player } = (await play.select('Ahead-' + i, false))!;
      await store.run('INSERT INTO review_points (player, receipt, answered_at, half_points) VALUES (?, ?, ?, ?)',
        player.id, 'fixture-one', now, 24);
    }
    const outside = (await play.select('Outside', false))!.player;
    const outsideCard = (await play.next(outside))!;
    now += 1999;
    assert.equal((await play.answer(outside, outsideCard.id, true))?.promotion, null);
    assert.equal((await play.leaderboard(outside)).you?.rank, 11);
    assert.deepEqual(await play.totals(outside), { points: 5, answers: 1 });
    const visitCard = (await play.next(outside))!;
    const { proof } = play.recordLink(outside, visitCard.id, 'A')!;
    assert.equal(play.recordLink(first, visitCard.id, 'B'), undefined);
    now += 19999;
    assert.equal((await play.answer(outside, visitCard.id, false, [proof, proof, 'fake']))?.earned, 16.5);
    const sprinter = (await play.select('Sprinter', false))!.player;
    for (let i = 0; i < 5; i++) {
      await store.run('INSERT INTO review_points (player, receipt, answered_at) VALUES (?, ?, ?)',
        sprinter.id, 'speed-' + i, now + i * 24000);
    }
    assert.equal((await play.leaderboard(sprinter)).you?.speedBadge, false);
    await store.run('INSERT INTO review_points (player, receipt, answered_at) VALUES (?, ?, ?)',
      sprinter.id, 'speed-5', now + 120001);
    assert.equal((await play.leaderboard(sprinter)).you?.speedBadge, false);
    await store.run('UPDATE review_points SET answered_at = ? WHERE player = ? AND receipt = ?',
      now + 120000, sprinter.id, 'speed-5');
    now += 3600000;
    assert.equal((await play.leaderboard(sprinter)).you?.speedBadge, true);
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
  assert.deepEqual(await first.json(), { name: 'Audit fan', points: 0, answers: 0 });
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

  const pair = tokens.read(1, card.id)!;
  const fullCard = tokens.issue(1, pair, Date.now() - 21000);
  const linkProofs = await Promise.all(['A', 'B'].map(async side =>
    (await (await request('link', cookie, { cardId: fullCard, side })).json()).proof));
  const save = { cardId: fullCard, answer: prediction(fullCard), linkProofs };
  const tampered = (card.id.startsWith('A') ? 'B' : 'A') + card.id.slice(1);
  assert.equal((await request('answer', cookie, { ...save, cardId: tampered })).status, 404);
  const attempts = await Promise.all([
    request('answer', cookie, save),
    request('answer', secondCookie, save),
  ]);
  const repeated = await Promise.all(attempts.map(attempt => attempt.json()));
  assert.equal(repeated.filter(result => result.promotion === 1).length, 1);
  assert.equal(repeated.filter(result => result.earned === 20).length, 1);
  for (const result of repeated) {
    assert.deepEqual({ ...result, promotion: null, earned: null },
      { answer: save.answer, points: 20, answers: 1, promotion: null, earned: null });
  }
  const next = await (await request('card', secondCookie)).json();
  assert.notEqual(next.id, card.id);
  const disagreement = { cardId: next.id, answer: !prediction(next.id) };
  const secondVote = await (await request('answer', secondCookie, disagreement)).json();
  assert.equal(secondVote.points, 20 + secondVote.earned);
  const board = await (await request('leaderboard', cookie)).json();
  assert.deepEqual(board.you, { name: 'Audit fan', rank: 1, points: secondVote.points,
    livePoints: secondVote.points, answers: 2, speedBadge: false });

  await stop();
  const recorded = openDb(dbFile);
  assert.equal(recorded.prepare('SELECT COUNT(*) AS n FROM review_points').get()?.n, 2);
  assert.equal(recorded.prepare('SELECT COUNT(*) AS n FROM disagreements').get()?.n, 1);
  recorded.close();
  await start();
  assert.deepEqual(await (await request('session', cookie)).json(),
    { name: 'Audit fan', points: secondVote.points, answers: 2 });
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
