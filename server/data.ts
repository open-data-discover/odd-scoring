import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sourceSha = 'b72e80ea4176dd43ce53ffd7d48d5feca0c5b1c6';
export const dataDir = '.data/upstream/' + sourceSha;
export const descriptionsPath = '.data/upstream/descriptions.json';
const files = ['manifest.json', 'columns.parquet', 'joins.parquet'];

async function downloadDescriptions() {
  const endpoint = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_search';
  const descriptions: Record<string, string> = Object.create(null);
  const rows = 100;
  for (let start = 0; ; start += rows) {
    const response = await fetch(endpoint + '?rows=' + rows + '&start=' + start + '&sort=name+asc', {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error('Catalog HTTP ' + response.status);
    const { success, result } = await response.json() as {
      success: boolean;
      result: { count: number; results: { name: string; notes?: string }[] };
    };
    if (!success || !Number.isFinite(result?.count)) throw new Error('Invalid catalog response');
    for (const { name, notes } of result.results) {
      const plain = notes?.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/<[^>]+>/g, ' ').replace(/^\s*#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();
      if (plain) descriptions[name] = plain.slice(0, 1200);
    }
    if (start + rows >= result.count) break;
    if (result.results.length < rows) throw new Error('Incomplete catalog response');
  }
  const tmp = descriptionsPath + '.' + process.pid + '.tmp';
  await writeFile(tmp, JSON.stringify(descriptions));
  await rename(tmp, descriptionsPath);
  console.log('Cached ' + Object.keys(descriptions).length + ' dataset descriptions');
}

async function download(repo?: string) {
  const root = 'https://raw.githubusercontent.com/open-data-discover/open-data-discover/';
  await mkdir(dataDir, { recursive: true });
  for (const file of files) {
    const source = 'web/public/data/' + file;
    if (repo) {
      const bytes = execFileSync('git', ['-C', repo, 'show', sourceSha + ':' + source], {
        maxBuffer: 64 * 1024 * 1024,
      });
      await writeFile(join(dataDir, file), bytes);
    } else {
      const response = await fetch(root + sourceSha + '/' + source, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error('Could not fetch ' + source + ': HTTP ' + response.status);
      await writeFile(join(dataDir, file), Buffer.from(await response.arrayBuffer()));
    }
  }
  console.log('Fetched upstream data at ' + sourceSha);
  try {
    await downloadDescriptions();
  } catch (error) {
    console.warn('Dataset descriptions could not be refreshed. Existing cache will be used if available.', error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await download(process.argv[2]);
}
