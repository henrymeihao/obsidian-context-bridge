export interface ReadEnv {
  WEBDAV_ROOT: string;
  ALLOWED_NOTES: string;
  ACCESS_MODE?: string;
  WEBDAV_USERNAME: string;
  WEBDAV_PASSWORD: string;
}

export function allowedNotes(env: ReadEnv): string[] {
  return env.ALLOWED_NOTES.split(',').map(s => s.trim()).filter(Boolean);
}

export function noteUrl(env: ReadEnv, path: string): string {
  const parts = safeParts(path);
  if (!/\.md$/i.test(path) || (env.ACCESS_MODE !== 'vault' && !allowedNotes(env).includes(path))) {
    throw new Error('Note is outside the read allowlist.');
  }
  return rootUrl(env) + parts.map(encodeURIComponent).join('/');
}

export function safeParts(path: string, allowRoot = false): string[] {
  if (allowRoot && path === '') return [];
  const parts = path.split('/');
  if (!path || path.length > 2048 || /[\\%\x00-\x1f]/.test(path) || parts.some(s => !s || s === '.' || s === '..' || s.startsWith('.'))) {
    throw new Error('Note path is outside the permitted vault.');
  }
  return parts;
}

function rootUrl(env: ReadEnv): string {
  const root = env.WEBDAV_ROOT.split('/');
  if (root.some(s => !s || s === '.' || s === '..' || /[\\%?#\x00-\x1f]/.test(s))) {
    throw new Error('Invalid WebDAV root.');
  }
  return 'https://dav.jianguoyun.com/dav/' + root.map(encodeURIComponent).join('/') + '/';
}

function authorization(env: ReadEnv): string {
  if (!env.WEBDAV_USERNAME || !env.WEBDAV_PASSWORD) throw new Error('WebDAV is not configured.');
  const bytes = new TextEncoder().encode(`${env.WEBDAV_USERNAME}:${env.WEBDAV_PASSWORD}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

async function request(env: ReadEnv, url: string, init: RequestInit, fetcher: typeof fetch) {
  const response = await fetcher(url, {
    ...init, redirect: 'manual', cache: 'no-store',
    headers: { ...init.headers, Authorization: authorization(env) },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`WebDAV read failed (${response.status}).`);
  }
  return response;
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Note or directory exceeds ${maxBytes} bytes.`);
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error(`Note or directory exceeds ${maxBytes} bytes.`); }
      chunks.push(value);
    }
  }
  const content = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(content);
}

export async function readNote(env: ReadEnv, path: string, fetcher: typeof fetch = fetch, options: { offset?: number; length?: number; startLine?: number; endLine?: number } = {}) {
  const url = noteUrl(env, path);
  const response = await request(env, url, { method: 'GET' }, fetcher);
  const fullText = (await boundedText(response, env.ACCESS_MODE === 'vault' ? 16 * 1024 * 1024 : 128 * 1024)).replace(/\r\n?/g, '\n');
  let offset = options.offset ?? 0;
  const length = options.length ?? 20000;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > 30000) throw new Error('Note paging parameters are invalid.');
  let stop = fullText.length;
  if (options.startLine != null || options.endLine != null) {
    const start = options.startLine ?? 1, end = options.endLine;
    if (options.offset != null || !Number.isInteger(start) || start < 1 || (end != null && (!Number.isInteger(end) || end < start))) throw new Error('Note line range is invalid; do not combine startLine/endLine with offset.');
    const lines = fullText.split('\n');
    offset = start > lines.length ? fullText.length : lines.slice(0, start - 1).reduce((sum, line) => sum + line.length + 1, 0);
    if (end != null) stop = lines.slice(0, end).join('\n').length;
  }
  const text = fullText.slice(offset, Math.min(stop, offset + length));
  const startLine = fullText.slice(0, offset).split('\n').length;
  const endLine = fullText.slice(0, offset + Math.max(0, text.length - 1)).split('\n').length;
  return { path, text, offset, startLine, endLine, totalCharacters: fullText.length, nextOffset: offset + text.length < stop ? offset + text.length : null,
    source: { path, startLine, endLine, citation: `【${path}:L${startLine}${endLine === startLine ? '' : '-L' + endLine}】` },
    citationInstruction: 'Cite the source range when using this note; distinguish the author’s statements from your own inference.', etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'), fetchedAt: new Date().toISOString() };
}
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface Entry { path: string; type: 'directory' | 'note'; bytes: number | null; lastModified: string | null; etag?: string | null }
export function parseDirectory(env: ReadEnv, path: string, xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('WebDAV returned invalid directory XML.');
  const data = new XMLParser({ removeNSPrefix: true, parseTagValue: false, ignoreAttributes: false }).parse(xml);
  if (!data.multistatus) throw new Error('WebDAV returned an unexpected directory response.');
  const array = (v: any): any[] => v == null ? [] : Array.isArray(v) ? v : [v];
  const root = decodeURIComponent(new URL(rootUrl(env)).pathname);
  const parent = path ? path + '/' : '';
  const entries: Entry[] = [];
  const responses = array(data.multistatus.response);
  for (const item of responses) {
    if (typeof item.href !== 'string') continue;
    let relative: string;
    try {
      const href = new URL(item.href, rootUrl(env));
      const decoded = decodeURIComponent(href.pathname);
      if (href.origin !== 'https://dav.jianguoyun.com' || !decoded.startsWith(root)) continue;
      relative = decoded.slice(root.length).replace(/\/$/, '');
      safeParts(relative);
    } catch { continue; }
    if (!relative.startsWith(parent) || relative.slice(parent.length).includes('/') || relative === path) continue;
    const prop = array(item.propstat).find(p => /\s200\s/.test(p.status || ''))?.prop;
    if (!prop) continue;
    const directory = typeof prop.resourcetype === 'object' && prop.resourcetype != null && 'collection' in prop.resourcetype;
    if (!directory && !/\.md$/i.test(relative)) continue;
    const size = Number(prop.getcontentlength);
    entries.push({ path: relative, type: directory ? 'directory' : 'note', bytes: !directory && Number.isFinite(size) && size >= 0 ? size : null, lastModified: prop.getlastmodified || null, etag: prop.getetag || null });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, serverMayHaveMore: responses.length >= 750 };
}

export async function listDirectory(env: ReadEnv, path = '', offset = 0, limit = 100, fetcher: typeof fetch = fetch) {
  if (env.ACCESS_MODE !== 'vault') throw new Error('Note directory access is disabled.');
  const parts = safeParts(path, true);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Note paging parameters are invalid.');
  const url = rootUrl(env) + (parts.length ? parts.map(encodeURIComponent).join('/') + '/' : '');
  const response = await request(env, url, { method: 'PROPFIND', headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>' }, fetcher);
  const result = parseDirectory(env, path, await boundedText(response, 2 * 1024 * 1024));
  const entries = result.entries.slice(offset, offset + limit);
  return { path, entries, total: result.entries.length, nextOffset: offset + entries.length < result.entries.length ? offset + entries.length : null, serverMayHaveMore: result.serverMayHaveMore };
}

export async function searchNotes(env: ReadEnv, query: string, basePath = '', cursor?: string, limit = 50, fetcher: typeof fetch = fetch) {
  safeParts(basePath, true);
  if (!query.trim() || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Note search parameters are invalid.');
  let queue: { path: string; offset: number }[] = [{ path: basePath, offset: 0 }];
  if (cursor) {
    try {
      if (cursor.length > 64000) throw new Error();
      const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cursor), c => c.charCodeAt(0))));
      if (parsed.query !== query || parsed.basePath !== basePath || !Array.isArray(parsed.queue) || parsed.queue.length > 2000) throw new Error();
      for (const item of parsed.queue) {
        safeParts(item.path, true);
        if (basePath && item.path !== basePath && !item.path.startsWith(basePath + '/')) throw new Error();
        if (!Number.isInteger(item.offset) || item.offset < 0 || item.offset > 100000) throw new Error();
      }
      queue = parsed.queue;
    } catch { throw new Error('Note search cursor is invalid.'); }
  }
  const matches: Entry[] = [];
  let requests = 0;
  let serverMayHaveMore = false;
  while (queue.length && requests < 20 && matches.length < limit) {
    const current = queue[0];
    const page = await listDirectory(env, current.path, current.offset, 200, fetcher);
    requests++;
    serverMayHaveMore ||= page.serverMayHaveMore;
    for (const entry of page.entries) {
      current.offset++;
      if (entry.type === 'directory') queue.push({ path: entry.path, offset: 0 });
      else if (entry.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) matches.push(entry);
      if (matches.length >= limit) break;
    }
    if (current.offset >= page.total) queue.shift();
  }
  const encoded = queue.length ? new TextEncoder().encode(JSON.stringify({ query, basePath, queue })) : null;
  if (encoded && encoded.length > 45000) throw new Error('Note search is too broad; choose a narrower directory.');
  return { query, matches, matchType: 'filename-and-path', nextCursor: encoded ? btoa(String.fromCharCode(...encoded)) : null, directoriesRequested: requests, serverMayHaveMore };
}
