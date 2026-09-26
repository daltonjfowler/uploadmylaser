# UploadMyLaser — Plan

A web app that lets students send simple jobs to the classroom **Boss LS36 (Ruida
controller)** from a **Chromebook over USB**, using **power/speed presets the teacher sets**.
LightBurn stays on the Windows laptop for complex teacher projects. This app handles "kid mode" only.

Sibling project: [uploadmycode](https://github.com/daltonjfowler/uploadmycode). This copies
its architecture almost one-for-one: Vite + vanilla TS frontend, a Cloudflare Worker, a
**Cloudflare Container that does the heavy processing**, Web Serial to the hardware, a teacher
key, and no student accounts.

| uploadmycode | uploadmylaser |
|---|---|
| sketch.ino → container (arduino-cli) → .hex | design.svg / .dxf → container (Python) → .rd bytes |
| browser: STK500v1 over Web Serial | browser: Ruida stream over Web Serial |
| Uno board hardcoded server-side | material presets stored server-side, power clamped server-side |

---

## 1. Goals / non-goals

**Goals (MVP)**
- Works on district Chromebooks in Chrome. Nothing to install, no license to lose.
- Student flow: open site → pick material → upload **SVG or DXF** (or type text) → preview on
  the bed → **Frame** → **Send**.
- Students **cannot change power or speed**. The server takes settings only from the teacher's
  presets and clamps them. The browser never supplies power values.
- Teacher page: edit materials/presets, machine config, max job time, and the class phrase.
- Vector cut, vector score, and "fill engrave" (hatch lines) for filled shapes and text.

**Non-goals (for now)**
- Photo/raster engraving (Phase 4).
- Camera, rotary, nesting, and node editing. Use LightBurn for those.

---

## 2. Architecture

```
Chromebook (Chrome)                          Cloudflare
┌─────────────────────────────┐   POST /api/process   ┌──────────── Worker (src/worker.ts) ───────────┐
│ UI: upload, material, place │ ─────────────────────►│ phrase check, rate limit, size limit          │
│ canvas preview of returned  │   {file, type,        │ loads Material + MachineConfig from KV        │
│   toolpaths                 │    materialId,        │ forwards to LaserContainer (Durable Object)   │
│ Web Serial ── USB ──► Ruida │    placement}         │           │                                   │
│  (streams .rd bytes, STOP)  │ ◄─────────────────────│           ▼                                   │
└─────────────────────────────┘  {preview, rd(b64),   │  container/ (Python, FastAPI)                 │
                                  frameRd(b64),       │  SVG/DXF → polylines → hatch/order → encode   │
                                  estimateS, warnings}└───────────────────────────────────────────────┘
```

- **Container = Python** (not Node like uploadmycode). The laser/geometry tools are far better
  in Python:
  - `ezdxf`: DXF (LINE, LWPOLYLINE, ARC, CIRCLE, SPLINE, ELLIPSE, INSERT blocks)
  - `svgelements`: SVG with transforms, units, viewBox, and CSS colors (MeerK40t uses it too)
  - `shapely`: fill hatching with holes, offsets, and bounds
  - The Ruida encoder is written in Python using MeerK40t as the reference. MeerK40t is MIT
    licensed; confirm before copying code and credit it in `CREDITS.md`.
- **Worker** is uploadmycode's skeleton: `LaserContainer` replaces `CompilerContainer`, and it
  keeps the `Counters` Durable Object, `CLASS_KV`, the phrase header, and CIDR lock.
  `max_instances: 2`, `instance_type: "basic"`, plus the teacher "warm up" button for cold starts.
- **The browser stays thin**, which is good for slow Chromebooks. It handles UI, canvas preview,
  and Web Serial. The only Ruida logic in the browser is `swizzle()` plus a hard-coded
  **STOP** command, so STOP works even if the server is down.
- **Server-side authority on safety:** the request carries `materialId`, never power/speed. The
  container re-clamps everything to `absoluteMaxPowerPct` and enforces `maxJobMinutes` before
  producing any bytes.
- **Stateless:** uploads are processed in memory and nothing is stored. Designs are kept in the
  student's localStorage, like sketches in uploadmycode.

### The laser station
The laser's USB cable plugs into **one Chromebook at a time**. MVP: a student walks their
Chromebook to the laser, plugs in, and sends. On ChromeOS, the Ruida's FTDI USB chip
(VID 0x0403 / PID 0x6001) is supported natively, so there's no Windows driver/VCP issue.
(Phase 4 option: a submit-and-release queue where the teacher's station sends the jobs.)

---

## 3. What we know about the Ruida protocol (verify in Phase 0)

Sources: [EduTech wiki: Ruida](https://edutechwiki.unige.ch/en/Ruida),
[jnweiger/ruida-laser protocol.md](https://github.com/jnweiger/ruida-laser/blob/master/doc/protocol.md),
[kkaempf/ruida serial_protocol.md](https://github.com/kkaempf/ruida/blob/master/doc/serial_protocol.md),
[MeerK40t ruida driver](https://github.com/meerk40t/meerk40t/tree/main/meerk40t/ruida)
(the working reference. Read `controller.py`, `emulator.py`, and the encoder).

- **Controller confirmed: RDC6445S** (644x family → magic 0x88).
- USB = FTDI **FT245R FIFO**. Per MeerK40t `usb_transport.py`: **no ACK, no checksum, and baud
  "doesn't seem to matter"** (they use 115200 with RTS/CTS + DSR/DTR). Other docs mention 38400 and 19200.
  The Phase 0 replay settles it.
- Bytes are **swizzled**, and the magic depends on the controller model (0x88 for 644xG,
  0x11 for 634xG):
  ```
  swizzle(b):   b ^= (b>>7)&0xFF; b ^= (b<<7)&0xFF; b ^= (b>>7)&0xFF; b ^= magic; b = (b+1)&0xFF
  unswizzle(b): b = (b-1)&0xFF; b ^= magic; b ^= (b>>7)&0xFF; b ^= (b<<7)&0xFF; b ^= (b>>7)&0xFF
  ```
- Command bytes have the high bit set, and data bytes are 7-bit. Values are packed as 14-bit or
  35-bit numbers. Coordinates are in µm.
- Key commands: `0x88` move abs, `0xA8` cut abs, `0x89/0xA9` move/cut rel, `0xC6…` power,
  `0xC9 02` speed, layer setup `0xCA…`, `0xD7` end of file. Copy the file header and bbox
  from LightBurn-generated `.rd` files.
- STOP = `D8 01`, pause `D8 02`, resume `D8 03` (swizzled like everything else).

---

## 4. Shared contracts (lead writes these FIRST, then workers fan out)

The contracts live in two languages and must stay in sync: `shared/contracts.ts` (browser and
Worker) and `container/app/models.py` (pydantic). Both are frozen before Phase 1.

```ts
type Mm = number;
type OpKind = 'cut' | 'score' | 'engrave';

interface OpSettings { speedMmS: number; powerMinPct: number; powerMaxPct: number;
                       passes: number; hatchMm?: number }
interface Material  { id: string; name: string; thicknessMm: number; enabled: boolean;
                      ops: Partial<Record<OpKind, OpSettings>> }
interface MachineConfig {
  bedWidthMm: number; bedHeightMm: number;
  origin: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  swizzleMagic: number;  baud: number;
  maxJobMinutes: number; absoluteMaxPowerPct: number; minSpeedMmS: number;
}

// Browser → Worker (multipart): file + JSON
interface ProcessRequest {
  fileType: 'svg' | 'dxf' | 'text';
  text?: { value: string; font: string; heightMm: number };
  materialId: string;
  placement: { xMm: Mm; yMm: Mm; scale: number; rotateDeg: 0 | 90 | 180 | 270 };
  colorMap?: Record<string, OpKind>;   // student answers "what is this color?"
}
// Worker → container: ProcessRequest + resolved Material + MachineConfig (from KV)

interface ProcessResponse {
  preview: { kind: OpKind; paths: [Mm, Mm][][] }[];  // bed coords, for canvas
  bboxMm: [Mm, Mm, Mm, Mm];
  rd: string;            // base64, swizzled, ready to stream
  frameRd: string;       // base64, laser-off trace of bbox
  estimateS: number;
  unknownColors: string[];                    // triggers the "what is this?" prompt
  warnings: string[];                         // "embedded image ignored", "text not converted to paths", ...
  errors: string[];                           // out of bed, too long, no material → no rd
}
```

**Color convention (SVG stroke/fill, DXF by layer name or ACI color):**
**black = cut through**, **red = mark** (op kind `score` internally, "Mark" in the UI),
**blue = engrave** (closed shapes get filled with hatch lines). Stroke or fill both count, but only
fills set explicitly (SVG's implicit black fill is ignored). DXF: a layer name containing
CUT/MARK/ENGRAVE, otherwise ACI 7 → cut, 1 → mark, 5 → engrave. Each material has one preset per
colour. Unknown colors are returned in `unknownColors` for the student to assign.

---

## 5. Phases and worker assignments

### Phase 0: Hardware spike (YOU at the laser, and blocks transport)
1. Note the controller model on the panel (e.g. RDC6445GZ). This sets the swizzle magic.
2. On the **Windows laptop in LightBurn**, make 4 tiny jobs (20 mm square cut, scored line,
   filled engrave square, text) and **File → Save RD file** for each. Put them in
   `test/golden/` with a screenshot of the LightBurn cut settings.
3. On a **student Chromebook**, open a one-page Web Serial test page (lead builds this first,
   before anything else). It connects, logs port info, **streams a golden `.rd` byte-for-byte**
   at 38400 (then 19200 if that fails), and logs every byte received. Use low power on cardboard.
4. Record: whether it cut, the working baud rate, bytes returned (ACKs?), whether the job
   starts immediately or waits for panel **Start**, origin corner, and bed size.
5. Check that **district policy allows Web Serial**. If Chrome never shows a port picker, IT
   needs to allow `SerialAskForUrls` / `DefaultSerialGuardSetting` for our domain.

Output: `docs/HARDWARE.md`, and the `MachineConfig` defaults filled in.

### Phase 1: Parallel fan-out (5 workers, against the frozen contracts)

| Worker | Scope | Key files | Done when |
|---|---|---|---|
| **W1 Ruida encoder (Py)** | swizzle, 7-bit number packing, command builders, file header/bbox, layer setup, `encode_job()`, `encode_frame()`, `decode_rd()` debug tool, time estimate, final power/speed clamp | `container/app/ruida/` | `decode_rd()` parses every golden file. The encoded 20 mm square matches LightBurn's command sequence, with coordinates within 1 µm |
| **W2 Geometry (Py)** | SVG (svgelements) + DXF (ezdxf) → mm polylines, curve flattening (0.05 mm tolerance), color/layer → op, text → paths (bundled OFL fonts), shapely hatching with holes, placement transform, path ordering (inner cuts before outer, nearest-neighbor), bounds checks | `container/app/geometry/` | Fixture files from Tinkercad, Inkscape, Canva SVG, and a CAD DXF produce correct layers, checked with snapshot tests |
| **W3 Container service + Worker** | FastAPI `POST /process` and `GET /health` in the Dockerfile (python:3.12-slim), wiring geometry → encoder. Fork uploadmycode's `src/worker.ts`: rename to `LaserContainer`, add `/api/process` and `/api/materials` (GET) plus the teacher `PUT`s in KV, keep phrase/rate limit/CIDR/Counters, **10 MB upload limit, 30 s timeout** | `container/`, `src/`, `wrangler.jsonc` | `wrangler dev` round-trips a fixture SVG to a valid `ProcessResponse` |
| **W4 Web Serial transport (TS)** | Port from uploadmycode's flash module. Filter for FTDI 0x0403, DTR/RTS init, chunked writes (with ACK waits if Phase 0 shows them), progress, hard-coded STOP, friendly errors ("unplug and replug", "close other tab") | `web/src/serial/` | A mock-port unit test passes, and the Phase 0 golden replay works through this module |
| **W5 Teacher page (TS)** | Material CRUD (clamped to `absoluteMaxPowerPct`), machine config, class phrase + TTL, warm-up button, **seed presets** (3 mm birch ply, cardboard, 3 mm acrylic, 1/8" MDF), and a "test square" button that runs a preset on the laser | `web/teacher/` | The teacher edits a preset and the student page reflects it |

W1 and W2 are pure Python with no hardware dependency, so they can start immediately (W1 needs
the golden files from Phase 0 step 2). W4 needs Phase 0 step 3 results before it can finish.

### Phase 2: Student UI (1 worker, after W3 has a working `/api/process`)
- **W6 UI:** material cards → upload/drag-drop (SVG/DXF) or "type your name" → a
  "what is this color?" prompt for `unknownColors` → canvas bed preview (mm grid, drag to
  place, scale, rotate 90°) with a debounced re-process on change → estimate and warnings →
  **Connect laser**, **Frame**, **Send**, and a big red **STOP**.
- Send is blocked if there are `errors`, or if the student hasn't ticked "I will stay with the
  laser the whole time."
- No framework, and canvas only (as in uploadmycode, keep the bundle small for slow Chromebooks).

#### Target look: "a bit like LightBurn", friendly for high schoolers
Reference: the mockup at https://claude.ai/artifact/FCvRwwKxxap8N63NYB47fE. The current `web/index.html`
is a plain first pass. W6 rebuilds it to this layout:
- **Layout:** title bar, toolbar (icons *with words*), size bar, left tools (Select, Text, Box, Circle),
  workspace with mm rulers, a palette of three colours only (Cut through / Mark / Engrave), and right
  docked panels **Layers** and **Laser** (step checklist, Frame, STOP, "I'll stay" tick, Send). Start
  from and Job origin are locked to *laser head / top-right*.
- **Open vs Import** (same meaning as LightBurn):
  - **Open…** = *start over with this file*. It clears the workspace (asking first if something's there) and
    loads one SVG/DXF.
  - **Import…** = *add this file to what's already here*, for example a logo next to a typed name. The
    imported file lands to the left of the existing design, selected, so it's easy to drag into place.
  - Each button shows this one-line explanation as a tooltip and in the hint strip. **Text** also adds to
    the design.
  - Contract change: `ProcessRequest` becomes `{ materialId, parts: Part[], colorMap, powerChoice }`, where
    `Part = { kind: 'file', fileIndex, fileType } | { kind: 'text', text }` plus
    `{ xMm, yMm, scale, rotateDeg }` *relative to the design's top-right corner*. The Worker accepts
    multipart `file0…fileN` (10 MB total). The container imports each part, places it, and concatenates
    Items before colour mapping, with groups kept distinct per part.
- **Fonts:** the Text tool offers `TEXT_FONTS` (shared/contracts.ts): Sans, Serif, Block, Chunky, Marker,
  Script, Stencil. Each is previewed in its own face. Stencil is recommended for Cut through, and
  script/marker warn when cut.
- **Run order:** the Layers panel lists layers in the order they run: Engrave → Mark → **Cut through (always
  last)**. The encoder enforces it (`RUN_ORDER` in encoder.py), with a test.

### Phase 3: Integration and QA (lead + 1 worker)
- End-to-end run on a Chromebook against the real laser, using cardboard.
- `docs/TEST_PLAN.md`: square, circle, nested shapes (the inner cut has to happen first), text,
  engrave fill, DXF with arcs/splines, jobs near each bed edge, STOP mid-job, unplug mid-job,
  and a cold container start.
- `docs/DEPLOY.md` (adapted from uploadmycode's) and `docs/STUDENT_GUIDE.md` (one page to post
  at the laser, including "how to export SVG from Tinkercad/Canva").

### Phase 3.5: "Send to panel" (teacher's preferred workflow)
Store the job in controller memory under a name (e.g. the student's first name + time), and frame and start
it from the laser's touchscreen, the way the class uses LightBurn's Send today. Blocked on capturing
the Ruida file commands (docs/HARDWARE.md → "Send to panel"). Once checked, add
`encode_store(name, job)` in the encoder and a **Send to panel** button that becomes the default, keeping
Frame/Start as extras.

### Phase 4: Stretch
- **Job queue:** students submit from their seat, and the teacher station reviews and sends. This
  avoids passing the cable around and adds a teacher approval step. It needs server-side storage
  (a Durable Object or R2) and would be the first persisted student data.
- Photo engraving (dither in the container).
- Upload to controller memory and run from the panel, if Phase 0 shows that's supported and safer.

---

## 6. Safety requirements (non-negotiable, and they apply to all workers)
- Power and speed come **only** from KV presets, resolved by the Worker. The container clamps
  them again. No endpoint accepts power/speed from a student.
- Materials are allowlisted by the teacher. **No PVC or vinyl** (they give off chlorine gas),
  and the teacher page warns if someone adds one.
- The STOP button works without the network. The physical E-stop and lid interlock remain the
  primary safety.
- Before every send, the student acknowledges "stay with the laser."
- Max job time is enforced server-side. Frame before cut is encouraged; consider making it
  required.

---

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| District Chromebook policy blocks Web Serial | Can't connect | Phase 0 step 5. Ask IT to allowlist the domain (uploadmycode will have hit the same issue, so reuse whatever worked there) |
| USB ACK/flow control undocumented | Dropped bytes or stalls | Golden replay, log replies, and copy MeerK40t's behavior |
| Wrong baud rate or magic | Garbage sent to the controller | Phase 0 confirms both. Both are in `MachineConfig`, so they're editable without a redeploy |
| Wrong origin or mirroring | Job lands in the wrong place | Phase 0 checks it, Frame gives a check before cutting, and first cuts are on cardboard |
| Container cold start (10–20 s) | Kids wait on the first file | Teacher warm-up button, and show a "warming up the laser brain…" message |
| Messy student files (clip paths, embedded images, text not converted to paths, unit mix-ups) | Bad output | Clear `warnings`. Treat DXF with no units as mm, and let the student confirm the size in the preview |

---

## 8. Repo layout

```
uploadmylaser/
├── PLAN.md  CLAUDE.md  CREDITS.md  package.json  wrangler.jsonc  tsconfig.json
├── shared/contracts.ts          # frozen TS contracts
├── src/worker.ts                # Worker: auth, rate limit, KV, LaserContainer DO
├── container/
│   ├── Dockerfile               # python:3.12-slim + fonts
│   ├── requirements.txt         # fastapi uvicorn svgelements ezdxf shapely pydantic
│   └── app/
│       ├── main.py  models.py   # FastAPI + pydantic mirror of contracts
│       ├── geometry/            # W2
│       └── ruida/               # W1
├── web/
│   ├── index.html  src/ui/      # W6 student app
│   ├── src/serial/              # W4
│   ├── teacher/                 # W5
│   └── serial-test.html         # Phase 0 spike page
├── test/
│   ├── golden/                  # LightBurn .rd files + settings screenshots
│   └── fixtures/                # sample SVG/DXF
└── docs/  HARDWARE.md  DEPLOY.md  TEST_PLAN.md  STUDENT_GUIDE.md
```

## 9. Order of operations
1. Lead: scaffold the repo from uploadmycode, write the contracts and `CLAUDE.md`, and build
   `web/serial-test.html`.
2. **You: Phase 0** (save the golden RD files in LightBurn, then run the Chromebook replay test).
3. Fan out W1, W2, W3, W5 immediately. W4 waits for the Phase 0 results.
4. W6 once `/api/process` works, then integration, cardboard tests, docs, and deploy.

## 10. Dev machine prerequisites
The Windows machine this plan was written on has **no git, Node, or Docker** installed. Install
them (or use a machine that has them) before scaffolding. As with uploadmycode, `wrangler dev`
needs Docker Desktop for the container.
- Git for Windows
- Node.js LTS
- Docker Desktop
- Python 3.12 (for running the container tests outside Docker)
- `gh` (optional)
