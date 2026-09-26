# Run your own copy

This repo is one teacher's classroom tool, published so other people can run it. The live site at
<https://uploadmylaser.com> is the author's own instance for one district, locked behind a class
phrase, so you want your own.

It is built for a **Ruida RDC6445S** controller (a Boss LS36 here). Other Ruida 644x controllers use
the same protocol and will probably work. Ruida 634x controllers need swizzle magic `0x11`
instead of `0x88` (set it on the teacher page). **Test on cardboard at low power first** with
[TEST_PLAN.md](TEST_PLAN.md), and read the Safety section of the [README](../README.md).

## What you need
| | |
|---|---|
| A Cloudflare account on **Workers Paid** | $5/month. Containers are not on the free plan. |
| **Node.js 22+** | <https://nodejs.org> |
| **Docker Desktop**, running | `wrangler deploy` builds the container image on your machine. |
| Optional: a domain on Cloudflare | otherwise you get `uploadmylaser.<you>.workers.dev` |
| Chromebooks (or any desktop Chrome/Edge) | Web Serial is Chrome-only. |

## Steps
```sh
git clone https://github.com/daltonjfowler/uploadmylaser
cd uploadmylaser
npm install
npx wrangler login
npx wrangler kv namespace create uploadmylaser-CLASS_KV
```
Then edit `wrangler.jsonc`:
- put the new KV id in `kv_namespaces` (binding stays `CLASS_KV`),
- change or delete the `routes` entries (`uploadmylaser.com`) to your own domain, or delete them to use workers.dev.

```sh
npm run types                         # regenerate Worker types after editing wrangler.jsonc
npm run deploy                        # first deploy pushes the container image: a few minutes
npx wrangler secret put TEACHER_KEY   # paste a long random string, e.g. from: node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

## First class
1. Open `/teacher/` and enter the key.
2. Set your **machine**: bed size, home corner, absolute max power. Check them against your laser.
3. Replace the seeded "Masonite / Luan" preset with **your own tested settings**. Every material
   needs test cuts on your machine first.
4. Set a class phrase and click **Warm up the processor**.
5. Work through [TEST_PLAN.md](TEST_PLAN.md) on cardboard, starting with the `/serial-test.html` replay.
6. If Chromebooks can't reach the site, school IT may need to unblock your domain.

[DEPLOY.md](DEPLOY.md) is the day-to-day manual.

## Running the container on its own
`docker build -t uml container && docker run -p 8080:8080 uml` serves `POST /process` and
`GET /health` on port 8080. It trusts whatever calls it (power settings arrive in the request), so
**never expose it to the internet**. In this project only the Worker can reach it.
