// Phase 0 spike: prove the USB transport by replaying LightBurn's own .rd output.
import { LaserLink } from './serial/laser';
import { unswizzle } from './ruida/swizzle';
import { initThemeButton } from './theme';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $<HTMLPreElement>('log');
initThemeButton($<HTMLButtonElement>('theme'));
let link: LaserLink | null = null;
let file: Uint8Array | null = null;
const t0 = performance.now();

function log(msg: string): void {
  logEl.textContent += `[${((performance.now() - t0) / 1000).toFixed(2)}s] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const magic = () => parseInt($<HTMLInputElement>('magic').value, 16) || 0x88;

/** Split unswizzled bytes into commands: each starts with a high-bit byte. */
function commands(plain: Uint8Array): Uint8Array[] {
  const out: number[][] = [];
  for (const b of plain) {
    if (b & 0x80 || !out.length) out.push([b]);
    else out[out.length - 1].push(b);
  }
  return out.map((c) => Uint8Array.from(c));
}

$('connect').onclick = async () => {
  try {
    link = new LaserLink({
      baud: Number($<HTMLSelectElement>('baud').value),
      magic: magic(),
      flowControl: $<HTMLSelectElement>('flow').value as FlowControlType,
      onReceive: (b) => log(`RX ${b.length}B raw: ${hex(b)}  | unswizzled: ${hex(unswizzle(b, magic()))}`),
      onDisconnect: () => { log('USB disconnected'); setConnected(false); },
    });
    await link.connect($<HTMLInputElement>('showAll').checked);
    const i = link.info;
    $('portInfo').textContent = `VID ${i?.usbVendorId?.toString(16)} PID ${i?.usbProductId?.toString(16)}`;
    log(`Connected: ${$('portInfo').textContent}, baud ${$<HTMLSelectElement>('baud').value}, flow ${$<HTMLSelectElement>('flow').value}`);
    setConnected(true);
  } catch (e) {
    log(`Connect failed: ${(e as Error).message}`);
  }
};

$('disconnect').onclick = async () => {
  await link?.disconnect();
  setConnected(false);
  log('Disconnected');
};

function setConnected(on: boolean): void {
  $<HTMLButtonElement>('connect').disabled = on;
  $<HTMLButtonElement>('disconnect').disabled = !on;
  $<HTMLButtonElement>('send').disabled = !on || !file;
}

$<HTMLInputElement>('file').onchange = async (ev) => {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (!f) return;
  file = new Uint8Array(await f.arrayBuffer());
  const cmds = commands(unswizzle(file, magic()));
  const last = cmds[cmds.length - 1];
  const looksRight = last?.length === 1 && last[0] === 0xd7;
  $('summary').textContent =
    `${f.name}: ${file.length} bytes, ${cmds.length} commands\n` +
    `first: ${cmds.slice(0, 4).map(hex).join(' | ')}\n` +
    `last:  ${cmds.slice(-3).map(hex).join(' | ')}\n` +
    (looksRight ? '✓ ends with D7 (end of file) with this magic' : '✗ does NOT end with D7. Wrong magic or not an .rd file.');
  log(`Loaded ${f.name} (${file.length} B)`);
  setConnected(!!link?.connected);
};

$('send').onclick = async () => {
  if (!link || !file) return;
  const prog = $<HTMLProgressElement>('progress');
  const start = performance.now();
  log(`TX start ${file.length} B`);
  try {
    await link.send(file, (s, t) => { prog.value = s / t; });
    log(`TX done in ${((performance.now() - start) / 1000).toFixed(2)}s. Watch the laser, and note whether it started on its own.`);
  } catch (e) {
    log(`TX failed: ${(e as Error).message}`);
  }
};

$('stop').onclick = async () => {
  try {
    await link?.stop();
    log('STOP sent (D8 01)');
  } catch (e) {
    log(`STOP failed: ${(e as Error).message}. Use the machine's E-stop!`);
  }
};

$('copy').onclick = () => navigator.clipboard.writeText(logEl.textContent ?? '');

if (!LaserLink.supported()) log('Web Serial is not available in this browser. Use Chrome.');
