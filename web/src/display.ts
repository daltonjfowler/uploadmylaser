// The projector window, like uploadmycode's /display: polls the phrase every 5 s with the key the
// teacher page remembered, and shows it as big as the window allows. Click to go full screen.

const KEY_STORAGE = 'uml.teacherKey'; // the entry teacher.ts writes
const POLL_MS = 5000; // a correct key is never rate limited

type State = 'start' | 'live' | 'none' | 'nokey';
let state: State = 'start';
let phrase = '';
let expiresAt = 0;
let ended = 'Students cannot use the laser right now.';
let offline = false;
let polling = false;

const $ = (id: string) => document.getElementById(id)!;

function loadKey(): string {
  try { return localStorage.getItem(KEY_STORAGE) ?? ''; } catch { return ''; }
}

function draw(): void {
  document.body.dataset.state = state;
  $('net').textContent = offline ? 'reconnecting...' : '';
  const el = $('phrase');
  if (state === 'live') {
    el.textContent = phrase;
    el.style.setProperty('--chars', String(Math.max(3, phrase.length)));
    tick();
  } else if (state === 'none') {
    el.textContent = 'no phrase set';
    el.style.setProperty('--chars', '13');
    $('sub').textContent = ended;
  } else if (state === 'nokey') {
    el.textContent = 'Open the teacher page on this computer and press "Remember on this machine".';
    el.style.setProperty('--chars', '40');
    $('sub').textContent = '';
  } else {
    el.textContent = '';
    $('sub').textContent = '';
  }
}

function tick(): void {
  if (state !== 'live') return;
  if (!expiresAt) {
    $('sub').textContent = '';
    return;
  }
  const left = Math.floor((expiresAt - Date.now()) / 1000);
  if (left <= 0) {
    state = 'none';
    expiresAt = 0;
    ended = 'That phrase has expired. Students cannot use the laser.';
    draw();
    return;
  }
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  $('sub').textContent = h > 0 ? `Expires in ${h} h ${m} min.` : m > 0 ? `Expires in ${m} min.` : `Expires in ${left} s.`;
}

async function poll(): Promise<void> {
  if (polling) return;
  const key = loadKey();
  if (!key) {
    state = 'nokey';
    offline = false;
    draw();
    return;
  }
  polling = true;
  try {
    const r = await fetch('/api/teacher/phrase', { headers: { 'x-teacher-key': key } });
    const body = await r.json().catch(() => null);
    if (r.ok && body) {
      offline = false;
      if (typeof body.phrase === 'string' && body.phrase) {
        state = 'live';
        phrase = body.phrase;
        expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : 0;
      } else {
        state = 'none';
        expiresAt = 0;
        ended = 'Students cannot use the laser right now.';
      }
    } else if (r.status === 401 || r.status === 403 || r.status === 429) {
      offline = false;
      state = 'nokey';
    } else {
      offline = true; // keep what is on screen; a projector that blanks on a hiccup is worse
    }
  } catch {
    offline = true;
  } finally {
    polling = false;
  }
  draw();
}

document.addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen?.().catch(() => {});
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void poll(); });

draw();
void poll();
setInterval(poll, POLL_MS);
setInterval(tick, 1000);
