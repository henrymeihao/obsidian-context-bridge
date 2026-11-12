import { RE2JS } from 're2js';
import { safeParts, type ReadEnv } from './read.js';

export interface SearchEnv extends ReadEnv { SEARCH_DB?: D1Database }
export interface SearchOptions {
  query: string; path?: string; glob?: string; regex?: boolean; caseSensitive?: boolean;
  contextLines?: number; limit?: number; cursor?: string;
}
interface IndexedNote { path: string; content: string; indexed_at: string; modified: string | null; etag: string | null }
export function compileQuery(query: string, regex = false, caseSensitive = false) {
  if (!query || query.length > 500 || query.includes('\n') || query.includes('\r')) throw new Error('Note query must be a single-line string of 1–500 characters.');
  try {
    const pattern = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return RE2JS.compile(pattern, caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE);
  } catch { throw new Error('Note regular expression is invalid or unsupported. Use RE2 syntax, without backreferences or lookaround.'); }
}
export function compileGlob(glob?: string) {
  if (!glob) return null;
  if (glob.length > 500 || glob.includes('\\') || glob.split('/').includes('..')) throw new Error('Note glob is invalid.');
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; pattern += '(?:.*/)?'; } else pattern += '.*';
    } else if (c === '*') pattern += '[^/]*';
    else if (c === '?') pattern += '[^/]';
    else pattern += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return RE2JS.compile(pattern + '$');
}
export function sourceReference(path: string, startLine: number, endLine: number) {
  return { path, startLine, endLine, citation: `【${path}:L${startLine}${endLine === startLine ? '' : '-L' + endLine}】` };
}
export function findLines(note: IndexedNote, options: SearchOptions, afterLine = 0, maxHits = 50) {
  const matcher = compileQuery(options.query, options.regex, options.caseSensitive);
  const lines = note.content.replace(/\r\n?/g, '\n').split('\n');
  const context = options.contextLines ?? 2;
  const hits = [];
  for (let i = afterLine; i < lines.length && hits.length < maxHits; i++) {
    if (!options.regex && !(options.caseSensitive ? lines[i].includes(options.query) : lines[i].toLowerCase().includes(options.query.toLowerCase()))) continue;
    const match = matcher.matcher(lines[i]);
    if (!match.find()) continue;
    const matchStart = match.start(), matchLength = match.end() - matchStart;
    const from = Math.max(0, i - context), to = Math.min(lines.length - 1, i + context);
    // Keep a bounded window around the actual match on unusually long lines.
    const begin = Math.max(0, matchStart - 300);
    const end = Math.min(lines[i].length, Math.max(begin + 1200, matchStart + Math.min(matchLength, 600)));
    hits.push({
      path: note.path, lineNumber: i + 1, column: matchStart + 1,
      text: lines[i].slice(begin, end), textColumnStart: begin + 1, lineTruncated: begin > 0 || end < lines[i].length,
      context: lines.slice(from, to + 1).map((text, n) => ({ lineNumber: from + n + 1, text: from + n === i ? text.slice(begin, end) : text.slice(0, 500) })),
      source: sourceReference(note.path, i + 1, i + 1), indexedAt: note.indexed_at, sourceModified: note.modified, etag: note.etag,
    });
  }
  return hits;
}
export async function indexStatus(env: SearchEnv) {
  if (!env.SEARCH_DB) throw new Error('Note full-text index is not configured.');
  const [meta, counts] = await Promise.all([
    env.SEARCH_DB.prepare('SELECT key,value FROM index_meta').all<{ key: string; value: string }>(),
    env.SEARCH_DB.prepare('SELECT COUNT(*) AS notes, MIN(indexed_at) AS oldestIndexedAt, MAX(indexed_at) AS newestIndexedAt FROM notes').first(),
  ]);
  const values = Object.fromEntries(meta.results.map(r => [r.key, r.value]));
  return { ...counts, root: values.root, lastFullScanAt: values.last_full_scan_at || null,
    initialSource: values.initial_source || null, sync: values.sync_state ? JSON.parse(values.sync_state) : null };
}
export async function searchContent(env: SearchEnv, options: SearchOptions) {
  if (!env.SEARCH_DB || env.ACCESS_MODE !== 'vault') throw new Error('Note full-text index is not configured.');
  const path = options.path || '';
  safeParts(path, true);
  compileQuery(options.query, options.regex, options.caseSensitive);
  const glob = compileGlob(options.glob);
  const limit = options.limit ?? 30, contextLines = options.contextLines ?? 2;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(contextLines) || contextLines < 0 || contextLines > 5) throw new Error('Note search parameters are invalid.');
  const root = await env.SEARCH_DB.prepare("SELECT value FROM index_meta WHERE key='root'").first<string>('value');
  if (root !== env.WEBDAV_ROOT) throw new Error('Note search index root does not match the permitted vault.');
  const signature = JSON.stringify([options.query, path, options.glob || '', !!options.regex, !!options.caseSensitive, contextLines]);
  let afterPath = '', afterLine = 0;
  if (options.cursor) {
    try {
      if (options.cursor.length > 12000) throw new Error();
      const cursor = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(options.cursor), c => c.charCodeAt(0))));
      if (cursor.signature !== signature || typeof cursor.path !== 'string' || !Number.isInteger(cursor.line) || cursor.line < 0) throw new Error();
      safeParts(cursor.path, true); afterPath = cursor.path; afterLine = cursor.line;
    } catch { throw new Error('Note search cursor is invalid.'); }
  }
  const hits: ReturnType<typeof findLines> = [];
  let scannedFiles = 0, exhausted = false, lastPath = afterPath, lastLine = afterLine;
  for (let batch = 0; batch < 20 && hits.length < limit; batch++) {
    const conditions = ['path >= ?'];
    const params: (string | number)[] = [afterPath];
    if (path) { conditions.push('(path = ? OR instr(path,?) = 1)'); params.push(path, path + '/'); }
    if (!options.regex) {
      conditions.push(`instr(${options.caseSensitive ? 'content' : 'lower_content'},?) > 0`);
      params.push(options.caseSensitive ? options.query : options.query.toLowerCase());
    }
    const rows = await env.SEARCH_DB.prepare(`SELECT path,content,indexed_at,modified,etag FROM notes WHERE ${conditions.join(' AND ')} ORDER BY path COLLATE BINARY LIMIT 20`).bind(...params).all<IndexedNote>();
    if (!rows.results.length) { exhausted = true; break; }
    for (const note of rows.results) {
      scannedFiles++;
      if (!glob || glob.test(note.path)) {
        const matches = findLines(note, { ...options, contextLines }, note.path === afterPath ? afterLine : 0, limit - hits.length);
        hits.push(...matches);
        if (hits.length === limit) { lastPath = note.path; lastLine = matches.at(-1)!.lineNumber; break; }
      }
      lastPath = note.path; lastLine = note.content.replace(/\r\n?/g, '\n').split('\n').length;
    }
    if (hits.length === limit) break;
    if (rows.results.length < 20) { exhausted = true; break; }
    afterPath = lastPath + '\u0001'; afterLine = 0;
  }
  const continuation = exhausted ? null : new TextEncoder().encode(JSON.stringify({ signature, path: lastPath, line: lastLine }));
  return { query: options.query, mode: 'content', regex: !!options.regex, caseSensitive: !!options.caseSensitive,
    matches: hits, nextCursor: continuation ? btoa(String.fromCharCode(...continuation)) : null, scannedFiles,
    freshness: 'Search uses an incrementally refreshed index; indexedAt is included on each hit. read_context reads the live WebDAV file.',
    citationInstruction: 'Cite factual claims using the returned source.citation. Separate quoted note content from your own inference.' };
}
