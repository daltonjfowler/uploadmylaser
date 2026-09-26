// The theme button: System, Light, Dark, and round again. public/theme-boot.js has already set
// data-theme before the first paint; this keeps it right afterwards (including a Chromebook that
// flips light/dark while the page is open on System). CSS and the canvas read only the attribute.

type Pref = 'system' | 'light' | 'dark';
const KEY = 'uml.theme';
const ORDER: Pref[] = ['system', 'light', 'dark'];
const LABELS: Record<Pref, string> = { system: '🖥️ System', light: '☀️ Light', dark: '🌙 Dark' };

function load(): Pref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function initThemeButton(button: HTMLButtonElement): void {
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  let pref = load();

  function apply(): void {
    const dark = pref === 'dark' || (pref === 'system' && darkQuery.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
    button.textContent = LABELS[pref];
    button.title = `Theme: ${pref}. Click for ${next}.`;
    button.setAttribute('aria-label', button.title);
  }

  button.addEventListener('click', () => {
    pref = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
    try {
      if (pref === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, pref);
    } catch { /* storage blocked: still works for this page */ }
    apply();
  });
  darkQuery.addEventListener('change', apply);
  apply();
}

/** Call `fn` whenever the theme attribute changes (the canvas redraws with its own colours). */
export function onThemeChange(fn: () => void): void {
  new MutationObserver(fn).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

export function isDark(): boolean {
  return document.documentElement.dataset.theme === 'dark';
}
