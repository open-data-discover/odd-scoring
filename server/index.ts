import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { parseCookie } from 'cookie';
import { dbPath, openCatalog, openDb } from './db.ts';
import { descriptionsPath, sourceSha } from './data.ts';
import { game, sessionAge } from './game.ts';
import { importExamples, importSnapshot } from './import.ts';
import { postgresPool, postgresStore, sqliteStore } from './store.ts';
import { prepareReviews, reviewKey } from './reviews.ts';

async function openStore() {
  if (process.env.DATABASE_URL) return postgresStore(postgresPool(process.env.DATABASE_URL, process.env.ODD_PG_SCHEMA));
  if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production');
  return sqliteStore(openDb());
}

const db = await openStore();
const cardKey = reviewKey(db.postgres ? undefined : dbPath);
await prepareReviews(db);
await db.all('SELECT source_sha, left_column, right_column FROM disagreements LIMIT 0');
const catalog = openCatalog();
await importSnapshot(catalog);
await importExamples(catalog);
const descriptions = await readFile(descriptionsPath, 'utf8').then(
  text => new Map(Object.entries(JSON.parse(text) as Record<string, string>)),
  (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return new Map<string, string>();
  },
);
const play = await game(db, sqliteStore(catalog), sourceSha, cardKey, undefined, undefined, descriptions);

const app = express();
const cookieName = 'odd_player';
app.disable('x-powered-by');
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', express.json({ limit: '4kb' }));

function player(req: express.Request) {
  const token = parseCookie(req.headers.cookie ?? '')[cookieName];
  return token && /^[a-f0-9]{64}$/.test(token) ? play.restore(token) : undefined;
}

app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
app.get('/api/session', async (req, res) => {
  const current = await player(req);
  res.json(current ? { name: current.name, points: await play.points(current) } : null);
});
app.post('/api/session', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().normalize('NFC') : '';
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,23}$/u.test(name)) {
    res.status(400).json({ error: 'Use 1–24 letters, numbers, spaces, hyphens or underscores, starting with a letter or number.' });
    return;
  }
  const session = await play.select(name, req.body.joinExisting === true);
  if (!session) {
    res.status(409).json({ code: 'name_taken' });
    return;
  }
  res.cookie(cookieName, session.token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: sessionAge,
  });
  res.json({ name: session.player.name, points: await play.points(session.player) });
});
app.get('/api/card', async (req, res) => {
  const current = await player(req);
  if (!current) {
    res.status(401).json({ error: 'Choose a username to get a card.' });
    return;
  }
  res.json(await play.next(current));
});
app.post('/api/answer', async (req, res) => {
  const current = await player(req);
  if (!current) {
    res.status(401).json({ error: 'Choose a username to save your answer.' });
    return;
  }
  const { cardId, answer } = req.body ?? {};
  if (typeof cardId !== 'string' || typeof answer !== 'boolean') {
    res.status(400).json({ error: 'Choose yes or no for the current card.' });
    return;
  }
  const result = await play.answer(current, cardId, answer);
  if (!result) {
    res.status(404).json({ error: 'This card is unavailable. Reload to get your current card.' });
    return;
  }
  res.json(result);
});
app.get('/api/leaderboard', async (req, res) => { res.json(await play.leaderboard(await player(req))); });
app.use('/api', (_req, res) => { res.status(404).json({ error: 'This endpoint is unavailable.' }); });
app.use(((error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const invalid = error.status === 400 || error.status === 413;
  if (!invalid) console.error(error);
  res.status(invalid ? error.status : 500).json({
    error: invalid ? 'The request is invalid.' : 'The server could not complete the request. Try again.',
  });
}) as express.ErrorRequestHandler);

app.use(express.static(resolve('dist')));
const port = Number(process.env.PORT ?? 3000);
app.listen(port, '0.0.0.0', () => {
  console.log('Join Check listening on port ' + port + ' (' + (db.postgres ? 'Postgres' : 'SQLite') + ')');
});
