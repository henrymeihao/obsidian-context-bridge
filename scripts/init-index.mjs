import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const project = fileURLToPath(new URL('../', import.meta.url));
// The supplied example is JSON-compatible; keep your copied config JSON-compatible too.
const config = JSON.parse(await readFile(path.join(project, 'wrangler.jsonc'), 'utf8'));
const root = config.vars?.WEBDAV_ROOT;
const database = config.d1_databases?.find(item => item.binding === 'SEARCH_DB')?.database_name;
if (typeof root !== 'string' || !root || !database || root.split('/').some(s => !s || s === '.' || s === '..' || /[\\%?#\x00-\x1f]/.test(s))) {
  throw new Error('Invalid WEBDAV_ROOT or SEARCH_DB configuration.');
}
// Never silently switch an existing index to a different permitted root.
const sql = `INSERT INTO index_meta(key,value) VALUES('root','${root.replaceAll("'", "''")}') ON CONFLICT(key) DO NOTHING; SELECT value AS configured_index_root FROM index_meta WHERE key='root';`;
if (process.argv.includes('--dry-run')) {
  console.log(sql);
} else {
  const child = spawn(process.execPath, [path.join(project, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', database, '--remote', '--command', sql, '--yes'], { cwd: project, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
