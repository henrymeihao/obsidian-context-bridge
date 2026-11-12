import { noteUrl, type ReadEnv } from './read.js';

export const DIET_PATH = '饮食记录.md';
export const DIET_SCOPE = 'context:append:diet';
const encoder = new TextEncoder();
const MAX = 1024 * 1024;

async function bytes(response: Response) {
  if (!response.ok) throw new Error(`Append read failed (${response.status}).`);
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > MAX) { await reader.cancel(); throw new Error('Append file exceeds 1 MiB.'); }
    chunks.push(part.value);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

export async function appendDiet(env: ReadEnv, input: { text: string; date: string; record_id: string }, fetcher: typeof fetch = fetch) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.record_id) || !input.text.trim() || input.text.length > 8000 || input.text.includes('<!-- diet-record:')) throw new Error('Append invalid record.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || new Date(input.date + 'T00:00:00Z').toISOString().slice(0, 10) !== input.date) throw new Error('Append invalid date.');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([input.date, input.text])));
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const prefix = `<!-- diet-record:${input.record_id}:`;
  const marker = `${prefix}${hash} -->`;
  const auth = btoa(String.fromCharCode(...encoder.encode(`${env.WEBDAV_USERNAME}:${env.WEBDAV_PASSWORD}`)));
  const url = noteUrl(env, DIET_PATH);
  const request = (init: RequestInit = {}) => fetcher(url, { ...init, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { Authorization: `Basic ${auth}`, ...init.headers } });
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request();
    const original = await bytes(response);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(original);
    if (text.includes(prefix)) {
      if (!text.includes(marker)) throw new Error('Append record ID already used for different content.');
      return { path: DIET_PATH, record_id: input.record_id, status: 'already_recorded' };
    }
    const etag = response.headers.get('etag');
    if (!etag || etag.startsWith('W/') || /[\r\n]/.test(etag) || !/^(?:"[^"\x00-\x20]*"|[^"\x00-\x20]+)$/.test(etag)) throw new Error('Append refused: strong ETag required.');
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const suffix = encoder.encode(`${text && !text.endsWith('\n') ? newline : ''}${newline}## ${input.date}${newline}${input.text.replace(/\r\n|\r|\n/g, newline)}${newline}${marker}${newline}`);
    if (original.length + suffix.length > MAX) throw new Error('Append file exceeds 1 MiB.');
    const updated = new Uint8Array(original.length + suffix.length);
    updated.set(original); updated.set(suffix, original.length);
    // Nutstore returns bare entity tags and compares them verbatim on PUT.
    // Echo the server's validator exactly; adding quotes causes permanent 412s.
    const put = await request({ method: 'PUT', headers: { 'If-Match': etag, 'Content-Type': 'text/markdown; charset=utf-8' }, body: updated });
    await put.body?.cancel();
    if (put.status === 412) continue;
    if (!put.ok) throw new Error(`Append failed (${put.status}); retry with the SAME record_id.`);
    const verified = new TextDecoder('utf-8', { fatal: true }).decode(await bytes(await request()));
    if (!verified.includes(marker)) throw new Error('Append verification failed; retry with the SAME record_id.');
    return { path: DIET_PATH, record_id: input.record_id, status: 'appended', date: input.date };
  }
  throw new Error('Append conflict: retry with the SAME record_id.');
}
