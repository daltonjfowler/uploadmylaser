/*
 * Stamp data-theme="light" or "dark" on <html> before the first paint, so a student who picked
 * Light on a dark Chromebook never sees a flash. A file, not an inline script, because the CSP is
 * script-src 'self'. The key and rule must match src/theme.ts.
 */
(function () {
  var pref = null;
  try {
    pref = window.localStorage.getItem('uml.theme');
  } catch (e) {
    // site data blocked: fall through to System
  }
  // Nothing saved yet: Dark (Dalton, 2026-10-28). System is saved as 'system' once picked.
  var dark = pref !== 'light' && (pref !== 'system' || window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
