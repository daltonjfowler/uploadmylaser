// Teacher page, in the same flow as uploadmycode's: the key, today's phrase (with a projector
// display and a pop-out window), then the laser's materials and machine settings.
import type { MachineConfig, Material, OpKind, OpSettings } from '../../shared/contracts';
import { OP_LABELS } from './ops';
import { initThemeButton } from './theme';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const KEY_STORAGE = 'uml.teacherKey'; // display.ts reads the same entry
const OPS: OpKind[] = ['cut', 'score', 'engrave'];
let materials: Material[] = [];
let machine: MachineConfig;

const keyInput = $<HTMLInputElement>('key');
const phraseInput = $<HTMLInputElement>('phrase');

function key(): string {
  return keyInput.value.trim();
}

class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (!key()) throw new ApiError(0, 'Type the teacher key first.');
  let r: Response;
  try {
    r = await fetch(path, {
      method,
      headers: { 'x-teacher-key': key(), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check the network.');
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) throw new ApiError(r.status, 'That teacher key was refused. Check it and try again.');
  // 429 only ever comes from the site-wide wrong-key guard; its sentence carries the wait.
  if (!r.ok) throw new ApiError(r.status, j.error ?? `Something went wrong (${r.status}).`);
  return j as T;
}

function say(text: string, tone: 'plain' | 'ok' | 'error' = 'plain'): void {
  $('message').textContent = text;
  $('message').dataset.tone = tone;
}

// ---------- key ----------

function loadKey(): string {
  try { return localStorage.getItem(KEY_STORAGE) ?? ''; } catch { return ''; }
}

$('remember').onclick = () => {
  try {
    localStorage.setItem(KEY_STORAGE, key());
    say('Key saved in this browser.', 'ok');
  } catch {
    say('This browser will not let the page save the key. Type it each time.', 'error');
  }
};
$('forget').onclick = () => {
  try { localStorage.removeItem(KEY_STORAGE); } catch { /* nothing saved */ }
  keyInput.value = '';
  $('panel').hidden = true;
  say('Key forgotten on this device.', 'ok');
};

// ---------- phrase ----------

// Short, spellable, classroom-safe. Three joined with hyphens read well off a projector.
const WORDS = [
  'apple', 'anchor', 'banjo', 'blue', 'bridge', 'cactus', 'candle', 'cedar', 'cherry', 'cobalt', 'comet', 'copper',
  'coral', 'crayon', 'delta', 'dragon', 'ember', 'falcon', 'ferry', 'forest', 'garden', 'ginger', 'granite', 'harbor',
  'hazel', 'indigo', 'island', 'jasper', 'jungle', 'kayak', 'lantern', 'lemon', 'lily', 'magnet', 'mango', 'maple',
  'marble', 'meadow', 'mint', 'nickel', 'olive', 'orbit', 'otter', 'pancake', 'pebble', 'pepper', 'piano', 'pilot',
  'planet', 'pumpkin', 'quartz', 'quilt', 'rabbit', 'radish', 'ranger', 'raven', 'river', 'robot', 'rocket', 'saffron',
  'sailor', 'silver', 'sparrow', 'spruce', 'sunset', 'tandem', 'thunder', 'tiger', 'timber', 'tulip', 'umbrella',
  'valley', 'velvet', 'walnut', 'willow', 'window', 'yellow', 'zebra',
];

function generatePhrase(): string {
  const picked: string[] = [];
  while (picked.length < 3) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    const w = WORDS[n % WORDS.length];
    if (!picked.includes(w)) picked.push(w); // "robot-robot-maple" reads like a typo
  }
  return picked.join('-');
}

interface PhraseState { phrase: string | null; expiresAt: number | null }
let expiresAt = 0;

function show(s: PhraseState): void {
  const live = !!s.phrase;
  expiresAt = live && typeof s.expiresAt === 'number' ? s.expiresAt : 0;
  $('phraseNow').textContent = live ? s.phrase! : 'no phrase set';
  $('display').dataset.live = live ? 'yes' : 'no';
  tick();
}

function tick(): void {
  const cd = $('countdown');
  if (!expiresAt) {
    cd.textContent = 'Students cannot use the laser right now.';
    return;
  }
  const left = Math.floor((expiresAt - Date.now()) / 1000);
  if (left <= 0) {
    expiresAt = 0; // the Worker stops accepting it at this moment too
    $('phraseNow').textContent = 'no phrase set';
    $('display').dataset.live = 'no';
    cd.textContent = 'That phrase has expired. Students cannot use the laser.';
    return;
  }
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} h`);
  if (h > 0 || m > 0) parts.push(`${m} min`);
  parts.push(`${left % 60} s`);
  cd.textContent = `Ends in ${parts.join(' ')}.`;
}

const normalize = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');
const clockTime = (ms: number | null) => {
  try { return ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; } catch { return ''; }
};

/** Once the key works, show the phrase and unlock the laser settings below it. */
async function refresh(okText = 'Up to date.'): Promise<boolean> {
  try {
    show(await api<PhraseState>('/api/teacher/phrase'));
    say(okText, 'ok');
    if ($('panel').hidden) await loadSettings();
    return true;
  } catch (e) {
    say((e as Error).message, 'error');
    return false;
  }
}

$('generate').onclick = () => {
  phraseInput.value = generatePhrase();
  phraseInput.focus();
};

$('set').onclick = async () => {
  const phrase = phraseInput.value.trim();
  if (!phrase) return say('Type a phrase, or press Generate.', 'error');
  const ttlMinutes = Number($<HTMLSelectElement>('duration').value);
  // Ask the server what is live rather than trusting this page: another teacher, in another
  // room, may have set theirs twenty minutes ago. One phrase serves the whole site.
  say('Checking whether a phrase is already live...');
  let live: PhraseState;
  try {
    live = await api<PhraseState>('/api/teacher/phrase');
  } catch (e) {
    if (e instanceof ApiError && e.status !== 0 && e.status < 500) return say(e.message, 'error');
    if (!confirm('Could not check whether a phrase is already live.\n\nSet this one anyway?')) return say('Nothing changed.');
    live = { phrase: null, expiresAt: null };
  }
  show(live);
  if (live.phrase && normalize(live.phrase) !== normalize(phrase)) {
    const ends = clockTime(live.expiresAt);
    const ok = confirm(`A class phrase is already live: ${live.phrase}${ends ? `\nIt was set to end at ${ends}.` : ''}`
      + '\n\nAnother class may be using the laser right now. Replacing it stops them until they are told the new phrase.\n\nReplace it?');
    if (!ok) return say('Left the phrase that was already live. Nothing changed.');
  }
  try {
    const r = await api<{ expiresAt: number }>('/api/teacher/phrase', 'POST', { phrase, ttlMinutes });
    show({ phrase: normalize(phrase), expiresAt: r.expiresAt });
    say('Phrase is live. Write it on the board.', 'ok');
    if ($('panel').hidden) await loadSettings();
  } catch (e) {
    say((e as Error).message, 'error');
  }
};

$('refresh').onclick = () => void refresh();
$('end').onclick = async () => {
  try {
    await api('/api/teacher/phrase', 'DELETE');
    show({ phrase: null, expiresAt: null });
    say('Phrase ended. Nobody can use the laser now.', 'ok');
  } catch (e) {
    say((e as Error).message, 'error');
  }
};
$('popout').onclick = () => {
  // The window reads the key from localStorage, so "Remember on this machine" must have been pressed.
  if (!loadKey()) return say('Press "Remember on this machine" first, so the pop-out window can read the phrase.', 'error');
  const w = window.open('/display/', 'uml-phrase-display', 'width=1000,height=420');
  if (!w) return say('Your browser blocked the pop-out. Allow pop-ups for this site and try again.', 'error');
  say('Phrase window opened. Drag it onto the projector screen.', 'ok');
};
$('warmup').onclick = async () => {
  say('Warming up the laser processor… (can take 20 s)');
  try {
    const r = await api<{ ok: boolean }>('/api/teacher/warmup', 'POST');
    say(r.ok ? 'Laser processor is ready.' : 'Not ready yet. Try again in a moment.', r.ok ? 'ok' : 'error');
  } catch (e) {
    say((e as Error).message, 'error');
  }
};

phraseInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('set').click(); });
keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('refresh').click(); });

async function loadSettings(): Promise<void> {
  const cfg = await api<{ materials: Material[]; machine: MachineConfig }>('/api/teacher/config');
  materials = cfg.materials;
  machine = cfg.machine;
  $('panel').hidden = false;
  renderMaterials();
  renderMachine();
}

// ---------- materials ----------

function field(label: string, value: string | number, onInput: (v: string) => void, type = 'number'): HTMLLabelElement {
  const l = document.createElement('label');
  l.append(label + ' ');
  const i = document.createElement('input');
  i.type = type;
  i.value = String(value);
  if (type === 'number') i.step = 'any';
  i.oninput = () => onInput(i.value);
  l.append(i);
  return l;
}

function renderMaterials(): void {
  $('materials').replaceChildren(...materials.map((m, idx) => {
    const box = document.createElement('div');
    box.className = 'card inner';
    const head = document.createElement('div');
    head.className = 'row';
    head.append(
      field('Name', m.name, (v) => (m.name = v), 'text'),
      field('Thickness mm', m.thicknessMm, (v) => (m.thicknessMm = Number(v))),
    );
    const en = document.createElement('label');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: m.enabled });
    cb.onchange = () => (m.enabled = cb.checked);
    en.append(cb, ' Students can use');
    const del = Object.assign(document.createElement('button'), { textContent: 'Delete', className: 'small' });
    del.onclick = () => { materials.splice(idx, 1); renderMaterials(); };
    head.append(en, del);
    box.append(head);

    for (const k of OPS) {
      const row = document.createElement('div');
      row.className = 'row';
      const on = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!m.ops[k] });
      const lab = document.createElement('label');
      lab.append(on, ` ${OP_LABELS[k]}`);
      lab.className = 'op';
      on.onchange = () => {
        if (on.checked) m.ops[k] = { speedMmS: 100, powerMinPct: 10, powerMaxPct: 15, passes: 1, ...(k === 'engrave' ? { hatchMm: 0.15 } : {}) };
        else delete m.ops[k];
        renderMaterials();
      };
      row.append(lab);
      const o = m.ops[k];
      if (o) {
        const set = (f: keyof OpSettings) => (v: string) => ((o as unknown as Record<string, number>)[f] = Number(v));
        row.append(
          field('Speed mm/s', o.speedMmS, set('speedMmS')),
          field('Min %', o.powerMinPct, set('powerMinPct')),
          field('Max %', o.powerMaxPct, set('powerMaxPct')),
          field('Passes', o.passes, set('passes')),
        );
        if (k === 'engrave') row.append(field('Line gap mm', o.hatchMm ?? 0.1, set('hatchMm')));
        // Blank = fixed power. Both set = students pick within the range (default is Max %).
        const opt = (f: 'studentMinPct' | 'studentMaxPct') => (v: string) => { o[f] = v.trim() === '' ? undefined : Number(v); };
        row.append(
          field('Student min %', o.studentMinPct ?? '', opt('studentMinPct')),
          field('Student max %', o.studentMaxPct ?? '', opt('studentMaxPct')),
        );
      }
      box.append(row);
    }
    return box;
  }));
}

$('addMat').onclick = () => {
  materials.push({ id: `mat-${Date.now().toString(36)}`, name: 'New material', thicknessMm: 3, enabled: false, ops: {} });
  renderMaterials();
};
$('saveMats').onclick = async () => {
  try {
    await api('/api/teacher/materials', 'PUT', materials);
    $('matMsg').textContent = 'Saved ✓';
    $('matMsg').className = 'small ok';
  } catch (e) {
    $('matMsg').textContent = (e as Error).message;
    $('matMsg').className = 'small err';
  }
};

// ---------- machine ----------

const MACHINE_FIELDS: [keyof MachineConfig, string][] = [
  ['bedWidthMm', 'Bed width (mm)'], ['bedHeightMm', 'Bed height (mm)'],
  ['absoluteMaxPowerPct', 'Absolute max power (%)'], ['minSpeedMmS', 'Min speed (mm/s)'],
  ['maxJobMinutes', 'Max job length (min)'], ['travelSpeedMmS', 'Travel speed for estimates (mm/s)'],
  ['swizzleMagic', 'Swizzle magic (136 = 0x88)'], ['baud', 'Baud'],
];

function renderMachine(): void {
  const box = $('machine');
  box.replaceChildren(...MACHINE_FIELDS.map(([k, label]) =>
    field(label, machine[k] as number, (v) => ((machine as unknown as Record<string, number>)[k] = Number(v)))));
  const l = document.createElement('label');
  l.append('Home corner ');
  const s = document.createElement('select');
  for (const o of ['top-right', 'top-left', 'bottom-right', 'bottom-left']) s.add(new Option(o, o, false, o === machine.origin));
  s.onchange = () => (machine.origin = s.value as MachineConfig['origin']);
  l.append(s);
  const l2 = document.createElement('label');
  l2.append('Job starts ');
  const s2 = document.createElement('select');
  s2.add(new Option('at the laser head (design corner = home corner)', 'relative', false, machine.jobOriginMode !== 'absolute'));
  s2.add(new Option('at a fixed bed position (student sets X/Y)', 'absolute', false, machine.jobOriginMode === 'absolute'));
  s2.onchange = () => (machine.jobOriginMode = s2.value as MachineConfig['jobOriginMode']);
  l2.append(s2);
  const l3 = document.createElement('label');
  l3.append('Send ');
  const s3 = document.createElement('select');
  s3.add(new Option('runs the job, waiting for Start on the panel', 'off', false, !machine.sendToPanel));
  s3.add(new Option('stores it by name in the panel file list (replaces the same name)', 'on', false, !!machine.sendToPanel));
  s3.onchange = () => (machine.sendToPanel = s3.value === 'on');
  l3.append(s3);
  box.append(l, l2, l3);
}

$('saveMachine').onclick = async () => {
  try {
    await api('/api/teacher/machine', 'PUT', machine);
    $('machMsg').textContent = 'Saved ✓';
    $('machMsg').className = 'small ok';
  } catch (e) {
    $('machMsg').textContent = (e as Error).message;
    $('machMsg').className = 'small err';
  }
};

initThemeButton($<HTMLButtonElement>('theme'));
keyInput.value = loadKey();
phraseInput.value = generatePhrase();
setInterval(tick, 1000);
tick();
if (keyInput.value) void refresh(); // a remembered key shows what is live without a click
