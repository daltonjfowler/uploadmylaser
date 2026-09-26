// uploadmylaser Worker: serves the frontend, stores presets in KV, gates students with the
// class phrase, and forwards designs to the Python container.
//
// Every response (static files too, `run_worker_first: true`) goes out through `fetch` below,
// which forces https + the canonical host and stamps the security headers (src/headers.ts).
//
// Safety rule: power/speed only ever come from KV (teacher presets). Student requests carry a
// materialId and nothing else that affects the laser beam (src/process-request.ts).
//
// Gate order for POST /api/process: size → school CIDR lock → class phrase → rate limits →
// strict validation → container. Limits run after the phrase so wrong guesses never spend
// anyone's budget. Nothing is ever per-IP punitive: a school shares one public IP.

import { Container, getContainer } from '@cloudflare/containers';
import { DurableObject } from 'cloudflare:workers';
import type { MachineConfig, Material } from '../shared/contracts.ts';
import { MAX_PARTS, MAX_UPLOAD_BYTES } from '../shared/contracts.ts';
import { ipAllowed, parseCidrList, type Cidr } from './cidr.ts';
import { constantTimeEquals } from './constant-time.ts';
import { canonicalRedirect, withSecurityHeaders } from './headers.ts';
import { HttpError, json } from './http.ts';
import {
  activeRecord, clampTtlMinutes, isUsablePhrase, MAX_PHRASE_LENGTH, MIN_PHRASE_LENGTH, normalizePhrase,
  PHRASE_KEY, type PhraseRecord,
} from './phrase.ts';
import { publicMachine, publicMaterials, validateMachine, validateMaterials } from './presets.ts';
import { MAX_REQUEST_JSON_BYTES, parseProcessRequest } from './process-request.ts';
import {
  checkProcessRate, GLOBAL_PROCESS_MAX_PER_MINUTE, PROCESS_MAX_PER_MINUTE, RATE_LIMIT_WINDOW_MS, rateLimitKey,
  RateLimiter, type RateVerdict,
} from './ratelimit.ts';
import { DEFAULT_MACHINE, SEED_MATERIALS } from './seed.ts';
import { minutesPhrase, TeacherKeyGuard, type GuardVerdict } from './teacher-guard.ts';

interface Env {
  ASSETS: Fetcher;
  CLASS_KV: KVNamespace;
  PROCESSOR: DurableObjectNamespace<LaserContainer>;
  COUNTERS: DurableObjectNamespace<Counters>;
  TEACHER_KEY?: string; // secret: npx wrangler secret put TEACHER_KEY
  ALLOWED_CIDRS?: string;
}

const KV_MATERIALS = 'materials';
const KV_MACHINE = 'machine';
const CONTAINER_TIMEOUT_MS = 30_000;
const TEACHER_REJECT_DELAY_MS = 300;
const MAX_TEACHER_BYTES = 4 * 1024;
const MAX_MATERIALS_BYTES = 64 * 1024;
// Multipart boundaries + the request JSON on top of the files.
const MAX_PROCESS_BODY_BYTES = MAX_UPLOAD_BYTES + MAX_REQUEST_JSON_BYTES + 64 * 1024;
const BUSY = 'The laser processor is starting up or busy. Wait a few seconds and try again.';

// Container concerns ONLY. Counters must not live here: every touch renews the container's sleep
// clock, so counting junk traffic on this object would keep it awake and billing.
export class LaserContainer extends Container {
  override defaultPort = 8080;
  override sleepAfter = '5m'; // same as uploadmycode: memory bills while awake, and a cold start is a few seconds

  override onError(error: unknown): unknown {
    console.error(JSON.stringify({ message: 'container error', error: String(error) }));
    return json({ error: BUSY }, 503);
  }
}

// Rate limits and the teacher-key guard, in one named instance every request shares. No container
// attached, so reaching it costs one DO call and never wakes the processor. In memory on purpose:
// if evicted the counts reset, which is fine for a fuse.
export class Counters extends DurableObject<Env> {
  readonly #clients = new RateLimiter(PROCESS_MAX_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
  readonly #everyone = new RateLimiter(GLOBAL_PROCESS_MAX_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
  readonly #teacherKeys = new TeacherKeyGuard();

  checkProcessRate(key: string): RateVerdict & { scope: 'client' | 'everyone' } {
    return checkProcessRate(this.#clients, this.#everyone, key, Date.now());
  }

  // Called only after a key already failed the compare, so it never refuses the right key.
  recordWrongTeacherKey(): GuardVerdict {
    return this.#teacherKeys.recordFailure(Date.now());
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Before anything else, and before any secret is read.
    const redirect = canonicalRedirect(req.url);
    if (redirect) return redirect;
    const url = new URL(req.url);
    const isApi = url.pathname.startsWith('/api/');
    try {
      if (!isApi) return withSecurityHeaders(await env.ASSETS.fetch(req), 'asset');
      return withSecurityHeaders(await route(req, env, url), 'json');
    } catch (e) {
      if (e instanceof HttpError) return withSecurityHeaders(json({ error: e.message }, e.status, e.headers), 'json');
      console.error(JSON.stringify({ message: 'unhandled worker error', path: url.pathname, error: String(e) }));
      return withSecurityHeaders(json({ error: 'Something went wrong on the server. Tell your teacher.' }, 500), 'json');
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/materials' && m === 'GET') return json(publicMaterials(await getMaterials(env)));
  if (p === '/api/machine' && m === 'GET') return json(publicMachine(await getMachine(env)));
  if (p === '/api/phrase/check' && m === 'POST') {
    checkCidr(req, env);
    await checkPhrase(req, env);
    return json({ ok: true });
  }
  if (p === '/api/process' && m === 'POST') return processDesign(req, env);

  // Everything under /api/teacher/ needs the key, even paths that do not exist.
  if (p.startsWith('/api/teacher/')) {
    await teacherGate(req, env);
    if (p === '/api/teacher/config' && m === 'GET') {
      return json({ materials: await getMaterials(env), machine: await getMachine(env), phraseSet: !!(await readActivePhrase(env)) });
    }
    if (p === '/api/teacher/materials' && m === 'PUT') {
      const mats = validateMaterials(await readJson(req, MAX_MATERIALS_BYTES), await getMachine(env));
      await env.CLASS_KV.put(KV_MATERIALS, JSON.stringify(mats));
      return json({ ok: true });
    }
    if (p === '/api/teacher/machine' && m === 'PUT') {
      const mc = validateMachine(await readJson(req, MAX_TEACHER_BYTES));
      await env.CLASS_KV.put(KV_MACHINE, JSON.stringify(mc));
      return json({ ok: true });
    }
    if (p === '/api/teacher/phrase') {
      if (m === 'GET') {
        const rec = await readActivePhrase(env);
        return json({ phrase: rec?.phrase ?? null, expiresAt: rec?.expiresAt ?? null });
      }
      if (m === 'POST') return setPhrase(req, env);
      if (m === 'DELETE') {
        await env.CLASS_KV.delete(PHRASE_KEY);
        return json({ ok: true });
      }
    }
    if (p === '/api/teacher/warmup' && m === 'POST') {
      try {
        return json({ ok: (await callContainer(env, '/health')).status === 200 });
      } catch (e) {
        console.error(JSON.stringify({ message: 'warmup failed', error: String(e) }));
        return json({ ok: false });
      }
    }
  }
  throw new HttpError(404, 'Not found.');
}

// ---------- design processing ----------

async function processDesign(req: Request, env: Env): Promise<Response> {
  const tooBig = `Your files are too big together (${MAX_UPLOAD_BYTES / 1024 / 1024} MB max).`;
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_PROCESS_BODY_BYTES) throw new HttpError(413, tooBig);
  checkCidr(req, env);
  await checkPhrase(req, env);

  const verdict = await countersStub(env).checkProcessRate(
    rateLimitKey(req.headers.get('x-client-id'), req.headers.get('cf-connecting-ip') ?? ''),
  );
  if (!verdict.allowed) {
    const s = verdict.retryAfterSeconds;
    const msg = verdict.scope === 'client'
      ? `You are changing your design very fast. Wait ${s} seconds and it will catch up.`
      : `The laser processor is very busy right now. Wait ${s} seconds and try again.`;
    throw new HttpError(429, msg, { 'retry-after': String(s) });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, 'Your design did not arrive in one piece. Try again.');
  }
  const files = new Map<number, File>();
  let total = 0;
  for (const [k, v] of form.entries()) {
    if (typeof v === 'string') continue;
    total += v.size;
    const mm = /^file(\d{1,3})$/.exec(k);
    if (mm && Number(mm[1]) < MAX_PARTS && String(Number(mm[1])) === mm[1]) files.set(Number(mm[1]), v);
  }
  if (total > MAX_UPLOAD_BYTES) throw new HttpError(413, tooBig);

  const pr = parseProcessRequest(form.get('request'), new Set(files.keys()));
  const material = (await getMaterials(env)).find((x) => x.id === pr.materialId && x.enabled);
  if (!material) throw new HttpError(400, 'Pick a material first.');

  // filesB64[i] is file<i>; slots no part refers to stay empty and are never read.
  const used = new Set(pr.parts.flatMap((x) => (x.kind === 'file' ? [x.fileIndex] : [])));
  const filesB64: string[] = new Array(used.size ? Math.max(...used) + 1 : 0).fill('');
  for (const i of used) filesB64[i] = toBase64(new Uint8Array(await files.get(i)!.arrayBuffer()));

  const body = JSON.stringify({ request: pr, material, machine: await getMachine(env), filesB64 });
  let r: { status: number; text: string };
  try {
    r = await callContainer(env, '/process', body);
  } catch (e) {
    const timedOut = e instanceof ContainerTimeout;
    console.error(JSON.stringify({ message: timedOut ? 'container timeout' : 'container unreachable', error: String(e) }));
    throw new HttpError(503, timedOut ? 'That design took too long to get ready. Try a simpler design, or try again.' : BUSY);
  }
  if (r.status === 422) throw new HttpError(400, 'The laser processor could not read that design. Reload the page and try again.');
  if (r.status === 503) throw new HttpError(503, BUSY);
  if (r.status !== 200) throw new HttpError(502, 'The laser processor had a problem. Try again in a moment.');
  return new Response(r.text, { headers: { 'content-type': 'application/json' } });
}

class ContainerTimeout extends Error {}

// The only place the container is reached (and its sleep clock renewed). Body read inside the
// timeout, so a stalled stream cannot hang the request either.
async function callContainer(env: Env, path: string, body?: string): Promise<{ status: number; text: string }> {
  const work = (async () => {
    const r = await getContainer(env.PROCESSOR).fetch(new Request('http://container' + path, body === undefined
      ? undefined
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
    return { status: r.status, text: await r.text() };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ContainerTimeout(`no answer in ${CONTAINER_TIMEOUT_MS} ms`)), CONTAINER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------- KV ----------

async function getMaterials(env: Env): Promise<Material[]> {
  return (await env.CLASS_KV.get<Material[]>(KV_MATERIALS, 'json')) ?? SEED_MATERIALS;
}

async function getMachine(env: Env): Promise<MachineConfig> {
  const stored = await env.CLASS_KV.get<Partial<MachineConfig>>(KV_MACHINE, 'json');
  return { ...DEFAULT_MACHINE, ...(stored ?? {}) };
}

async function readActivePhrase(env: Env): Promise<PhraseRecord | null> {
  let stored: unknown;
  try {
    stored = await env.CLASS_KV.get(PHRASE_KEY, 'json');
  } catch (e) {
    // Not JSON (e.g. an old plain-string phrase): treat as no phrase; the teacher sets a new one.
    console.error(JSON.stringify({ message: 'phrase in KV is not readable', error: String(e) }));
    return null;
  }
  return activeRecord(stored, Date.now());
}

async function setPhrase(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req, MAX_TEACHER_BYTES);
  const b = (typeof body === 'object' && body !== null ? body : {}) as { phrase?: unknown; ttlMinutes?: unknown };
  const phrase = normalizePhrase(b.phrase);
  if (!isUsablePhrase(phrase)) throw new HttpError(400, `Phrase must be ${MIN_PHRASE_LENGTH} to ${MAX_PHRASE_LENGTH} characters.`);
  const ttlMinutes = clampTtlMinutes(b.ttlMinutes);
  const rec: PhraseRecord = { phrase, expiresAt: Date.now() + ttlMinutes * 60_000 };
  // expirationTtl is KV's own cleanup; expiresAt is what the Worker enforces.
  await env.CLASS_KV.put(PHRASE_KEY, JSON.stringify(rec), { expirationTtl: ttlMinutes * 60 });
  return json({ ok: true, expiresInMinutes: ttlMinutes, expiresAt: rec.expiresAt });
}

// ---------- auth ----------

function countersStub(env: Env): DurableObjectStub<Counters> {
  return env.COUNTERS.get(env.COUNTERS.idFromName('counters'));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Key compared FIRST, so a correct key always gets in whatever anyone else is doing. Only a wrong
// key touches the guard. No secret uploaded means no teacher endpoint at all: never fall open.
async function teacherGate(req: Request, env: Env): Promise<void> {
  const expected = env.TEACHER_KEY ?? '';
  if (expected === '') console.error(JSON.stringify({ message: 'TEACHER_KEY is not set; teacher endpoint refused' }));
  else if (await constantTimeEquals(req.headers.get('x-teacher-key') ?? '', expected)) return;

  const guard = await countersStub(env).recordWrongTeacherKey();
  await sleep(TEACHER_REJECT_DELAY_MS);
  if (guard.locked) {
    throw new HttpError(429, `Too many wrong keys from everywhere right now. Try again in ${minutesPhrase(guard)}. The right key still works.`, {
      'retry-after': String(guard.retryAfterSeconds),
    });
  }
  throw new HttpError(401, 'Wrong teacher key.');
}

// A wrong phrase is a plain refusal every time: never counted, delayed or locked out.
async function checkPhrase(req: Request, env: Env): Promise<void> {
  const rec = await readActivePhrase(env);
  if (!rec) throw new HttpError(403, 'The laser is closed. Ask your teacher for today\'s class phrase.');
  const got = normalizePhrase(req.headers.get('x-class-phrase') ?? '');
  if (!(await constantTimeEquals(got, rec.phrase))) throw new HttpError(401, 'That class phrase is not right.');
}

// ALLOWED_CIDRS parsed once per isolate (config, not request data, so module scope is safe).
let cidrCache: { raw: string; cidrs: Cidr[] } | null = null;

function checkCidr(req: Request, env: Env): void {
  const raw = env.ALLOWED_CIDRS ?? '';
  if (cidrCache?.raw !== raw) {
    const { cidrs, invalid } = parseCidrList(raw);
    if (invalid.length) console.error(JSON.stringify({ message: 'ALLOWED_CIDRS entries not understood', invalid }));
    cidrCache = { raw, cidrs };
  }
  // Empty list = lock off. A list of only typos stays locked: a typo must not open the door.
  if (raw.trim() === '') return;
  if (!ipAllowed(req.headers.get('cf-connecting-ip') ?? '', cidrCache.cidrs)) {
    throw new HttpError(403, 'The laser only works from school.');
  }
}

// ---------- helpers ----------

async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, 'That request is too large.');
  const buf = await req.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new HttpError(413, 'That request is too large.');
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, 'The request was not valid JSON.');
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
