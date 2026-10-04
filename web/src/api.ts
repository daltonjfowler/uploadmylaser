import type { ProcessRequest, ProcessResponse, PublicMaterial } from '../../shared/contracts';
import { deviceId } from './device';

export interface PublicMachine {
  bedWidthMm: number;
  bedHeightMm: number;
  swizzleMagic: number;
  baud: number;
  maxJobMinutes: number;
  origin?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  jobOriginMode?: 'relative' | 'absolute'; // missing in old cached copies → treat as relative
  sendToPanel?: boolean;
}

const PHRASE_KEY = 'uml.phrase';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  const body = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
  // A 429 'locked' (too many wrong tries from this network) carries its sentence in `message`.
  const msg = body.error === 'locked' && typeof body.message === 'string' ? body.message : body.error;
  if (!r.ok) throw new ApiError(r.status, msg ?? `Server error ${r.status}`);
  return body as T;
}

/** DWG -> DXF on the processor (beta: LibreDWG). Resolves to the DXF's bytes, or throws ApiError with a sentence. */
export async function convertDwg(dwg: Uint8Array): Promise<Uint8Array> {
  const r = await call<{ dxfB64?: string; error?: string }>('/api/convert-dwg', {
    method: 'POST',
    body: dwg as BodyInit,
    headers: { 'content-type': 'application/octet-stream', 'x-class-phrase': getPhrase(), 'x-client-id': clientId(), 'x-device-id': deviceId() },
  });
  if (!r.dxfB64) throw new ApiError(422, r.error ?? 'That DWG could not be converted. In AutoCAD, use Save As and pick a DXF instead.');
  const bin = atob(r.dxfB64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Cached so the page still opens (and STOP still works) if the network drops. */
async function cached<T>(key: string, path: string): Promise<T> {
  try {
    const v = await call<T>(path);
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage full/blocked */ }
    return v;
  } catch (e) {
    try {
      const c = localStorage.getItem(key);
      if (c) return JSON.parse(c) as T;
    } catch { /* ignore */ }
    throw e;
  }
}

export const getMaterials = () => cached<PublicMaterial[]>('uml.materials', '/api/materials');
export const getMachine = () => cached<PublicMachine>('uml.machine', '/api/machine');

export function getPhrase(): string {
  try { return sessionStorage.getItem(PHRASE_KEY) ?? ''; } catch { return ''; }
}
export function setPhrase(p: string): void {
  try { sessionStorage.setItem(PHRASE_KEY, p); } catch { /* ignore */ }
}

export async function checkPhrase(p: string): Promise<void> {
  await call('/api/phrase/check', { method: 'POST', headers: { 'x-class-phrase': p, 'x-device-id': deviceId() } });
}

/** A random id per Chromebook, so the server's rate limit counts each student separately
 *  (the whole school shares one public IP). Not a credential. */
function clientId(): string {
  try {
    let id = localStorage.getItem('uml.clientId');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('uml.clientId', id);
    }
    return id;
  } catch {
    return '';
  }
}

/** `files[i]` is sent as multipart field `file<i>`, matching each file part's `fileIndex`. */
export async function processDesign(req: ProcessRequest, files: Blob[]): Promise<ProcessResponse> {
  const fd = new FormData();
  fd.set('request', JSON.stringify(req));
  files.forEach((f, i) => fd.set(`file${i}`, f, `file${i}`));
  return call<ProcessResponse>('/api/process', {
    method: 'POST',
    body: fd,
    headers: { 'x-class-phrase': getPhrase(), 'x-client-id': clientId(), 'x-device-id': deviceId() },
  });
}
