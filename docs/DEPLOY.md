# Deploy

Live at **https://uploadmylaser.com** (www redirects to it; `uploadmylaser.<subdomain>.workers.dev` stays on
as a fallback). Same Cloudflare account as uploadmycode, Workers Paid plan (needed for Containers).

## Already set up
- Domain `uploadmylaser.com`: zone on this Cloudflare account. The Worker claims it and `www` as custom
  domains (`routes` in wrangler.jsonc), and Cloudflare issues the HTTPS certificates.
- KV namespace `uploadmylaser-CLASS_KV` (id in wrangler.jsonc). It is separate from uploadmycode's `CLASS_KV`.
  Never point this app at that one.
- Secret `TEACHER_KEY`. To change it: `npx wrangler secret put TEACHER_KEY` and paste a long random string.

## Deploying a change
Needs Node.js LTS and Docker Desktop (running).
```
npm install
npm run typecheck && npm test && npm run test:py
npm run deploy        # builds web → public/, builds + pushes the container image, deploys the Worker
```
The first deploy pushes the Docker image, which takes a few minutes. Later deploys reuse cached layers.

## Security (see src/headers.ts and src/worker.ts)
- Every request goes through the Worker (`run_worker_first: true`): http → https 301, www → apex 301,
  HSTS, a strict CSP (scripts only from this site), `Permissions-Policy: serial=(self)` for Web Serial,
  no framing, `noindex`. Fonts are self-hosted, so student Chromebooks talk to no third party.
- Students: class phrase for anything that reaches the container (constant-time compare, expiry enforced), 40 previews a minute per Chromebook
  and 400 a minute for everyone (the bill guard), 10 MB upload cap, strict request validation. Power and
  speed only ever come from the teacher's presets in KV, and the container clamps them again.
- Teacher: `TEACHER_KEY` compared in constant time, 300 ms pause on a wrong key, and a site-wide guard
  after 100 wrong keys in 15 minutes that never locks out the right key. No per-IP lockouts, since the
  whole school shares one public IP.
- Optional school-only lock: set `ALLOWED_CIDRS` in wrangler.jsonc to the district's public IP ranges
  (IPv4/IPv6, comma-separated) and redeploy. Ask district IT for them.

## Daily routine
1. Open `/teacher/` (the **Teacher** link on the student page). Paste the key and press **Remember on this
   machine** once. Press **Generate** (or type a phrase), pick how long it lasts, and **Set phrase**. Project
   the page or **Pop out** the phrase window onto the projector, then **Warm up the laser processor**.
2. Students open `uploadmylaser.com`. The site opens for anyone, but it asks for the phrase as soon as
   a design needs processing. They plug a Chromebook into the laser when it's their turn.
3. At the end of class, click **End now**, or let the phrase expire.

## Chromebook policy
If Chrome never shows the USB port picker, district IT needs to allow Web Serial for this site
(Admin console → Chrome → User & browser settings: *Web Serial API*, allow `https://uploadmylaser.com`).

## Local development (home computer only, never on the school laptop)
- Wrangler can't run containers locally on Windows (it needs WSL). On Windows, test the Worker with
  `npx wrangler dev --enable-containers=false --host localhost --local-upstream localhost`
  (the `--host` flags stop the https redirect from looping on localhost), and the container on its own:
  `docker build -t uml container && docker run -p 8080:8080 uml`.
- `npm run dev:web`: Vite on :5173 with hot reload, proxying `/api` to :8787.
- Container tests: `cd container && python -m venv .venv && .venv\Scripts\pip install -r requirements-dev.txt && .venv\Scripts\python -m pytest -q`.
