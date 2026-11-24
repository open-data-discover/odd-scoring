import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { dataDir, sourceSha } from './data.ts';
import { transaction } from './db.ts';

type Column = {
  id: number;
  n_distinct: number;
  package: string;
  resource: string;
  resource_id: string;
  file: string;
  column: string;
};
type Pair = { id_a: number; id_b: number; score: number };
type Manifest = {
  format_version: number;
  created_at: string;
  counts: { columns: number; joins: number };
  parameters: { min_distinct: number };
  packages: { name: string; title: string | null }[];
};

async function readParquet<T>(dir: string, name: string, columns: string[]) {
  const file = await asyncBufferFromFile(join(dir, name + '.parquet'));
  return await parquetReadObjects({ file, columns }) as T[];
}

export async function importExamples(db: DatabaseSync, sha = sourceSha, dir = dataDir) {
  if (db.prepare('SELECT 1 FROM column_examples WHERE sha = ? LIMIT 1').get(sha)) return;
  const examples = await readParquet<{ id: number; samples: string[] | null }>(dir, 'columns', ['id', 'samples']);
  transaction(db, () => {
    const insert = db.prepare('INSERT OR IGNORE INTO column_examples VALUES (?, ?, ?)');
    for (const { id, samples } of examples) {
      const values = (samples ?? []).filter(value => typeof value === 'string' && value.trim())
        .slice(0, 3).map(value => value.length > 160 ? value.slice(0, 159) + '…' : value);
      insert.run(sha, id, JSON.stringify(values));
    }
  });
}

export async function importSnapshot(db: DatabaseSync, sha = sourceSha, dir = dataDir) {
  if (db.prepare('SELECT 1 FROM imports WHERE sha = ?').get(sha)) return;
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.format_version !== 2 || !Number.isFinite(Date.parse(manifest.created_at))
      || !Number.isInteger(manifest.parameters.min_distinct) || manifest.parameters.min_distinct < 1) {
    throw new Error('Invalid or unsupported upstream manifest');
  }
  const columns = await readParquet<Column>(dir, 'columns', [
    'id', 'n_distinct', 'package', 'resource', 'resource_id', 'file', 'column',
  ]);
  const detected = await readParquet<Pair>(dir, 'joins', ['id_a', 'id_b', 'score']);
  if (columns.length !== manifest.counts.columns || detected.length !== manifest.counts.joins
      || detected.length === 0) {
    throw new Error('Upstream file counts do not match the manifest or there are no joins');
  }
  const titles = new Map(manifest.packages.map(dataset => [dataset.name, dataset.title || dataset.name]));
  const files = new Map<number, string>();
  for (const column of columns) {
    if (!Number.isInteger(column.id) || column.id < 0 || column.id >= columns.length
        || files.has(column.id) || !titles.has(column.package)
        || !Number.isInteger(column.n_distinct)
        || !column.file || !column.resource_id || !column.column) {
      throw new Error('Invalid upstream column ' + column.id);
    }
    files.set(column.id, column.package + '/' + column.file);
  }
  const eligible = columns.filter(column => column.n_distinct >= manifest.parameters.min_distinct);
  const eligibleIds = new Set(eligible.map(column => column.id));
  const used = new Set<number>();
  for (const pair of detected) {
    const key = pair.id_a * columns.length + pair.id_b;
    if (!eligibleIds.has(pair.id_a) || !eligibleIds.has(pair.id_b) || pair.id_a >= pair.id_b
        || files.get(pair.id_a) === files.get(pair.id_b) || used.has(key)
        || !Number.isFinite(pair.score) || pair.score < 0 || pair.score > 1) {
      throw new Error('Invalid upstream pair ' + pair.id_a + '/' + pair.id_b);
    }
    used.add(key);
  }

  const groupSizes = new Map<string, number>();
  for (const column of eligible) {
    const file = files.get(column.id)!;
    groupSizes.set(file, (groupSizes.get(file) ?? 0) + 1);
  }
  let available = eligible.length * (eligible.length - 1) / 2;
  for (const size of groupSizes.values()) available -= size * (size - 1) / 2;
  if (available < detected.length * 2) throw new Error('Too few eligible random pairs');

  // Rebuild the same random pool on every host so review receipts keep matching their pairs.
  let block = Buffer.alloc(0);
  let offset = 0;
  let counter = 0;
  const range = 2 ** 32;
  const limit = range - (range % eligible.length);
  function pickColumn() {
    for (;;) {
      if (offset === block.length) {
        block = createHash('sha256').update(sha + ':random-pool-v1:' + counter++).digest();
        offset = 0;
      }
      const value = block.readUInt32LE(offset);
      offset += 4;
      if (value < limit) return eligible[value % eligible.length].id;
    }
  }
  const random: [number, number][] = [];
  // The real catalog has a sparse detected pool. Bound the rejection loop for malformed inputs.
  const maxDraws = Math.ceil(30 * detected.length * eligible.length ** 2 / (available * 2));
  for (let draws = 0; random.length < detected.length && draws < maxDraws; draws++) {
    const left = pickColumn();
    const right = pickColumn();
    if (files.get(left) === files.get(right)) continue;
    const a = Math.min(left, right);
    const b = Math.max(left, right);
    const key = a * columns.length + b;
    if (used.has(key)) continue;
    used.add(key);
    random.push([a, b]);
  }
  if (random.length !== detected.length) throw new Error('Random pool could not be generated');

  transaction(db, () => {
    db.prepare('INSERT INTO imports VALUES (?, ?, ?)').run(sha, manifest.created_at, detected.length);
    const addColumn = db.prepare('INSERT INTO columns VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const col of columns) {
      addColumn.run(sha, col.id, col.package, titles.get(col.package)!, col.file,
        col.resource || col.file, col.resource_id, col.column);
    }
    const addPair = db.prepare('INSERT INTO pairs VALUES (?, ?, ?, ?, ?, ?)');
    detected.forEach((pair, i) => addPair.run(sha, 'detected', i, pair.id_a, pair.id_b, pair.score));
    random.forEach(([a, b], i) => addPair.run(sha, 'random', i, a, b, null));
  });
  console.log('Imported ' + columns.length + ' columns and ' + detected.length + ' pairs per pool');
}
