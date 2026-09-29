<img src="web/public/icon.svg" width="72" height="72" alt="uploadmylaser logo: a friendly face with an upload arrow for a hat and laser eyes burning a wooden plank">

# uploadmylaser

A kid-safe laser sender for Chromebook classrooms. Students open a website, pick their material,
drop in an SVG or DXF (or type their name), arrange it on the laser bed, and send it to the
classroom **Boss LS36 laser (Ruida RDC6445S controller)** over USB with the Web Serial API. Nothing
is installed on the student machine: no laser software, no driver, no extension, no account.

It exists because managed Chromebooks cannot run desktop laser software, and a class of thirty needs
a simple, safe way to get a name tag or a box onto the laser. The desktop software stays on the
teacher's Windows laptop for complex projects. This handles "kid mode".

- **Students never choose power or speed.** The teacher sets presets per material. The server
  resolves them, and the processing container clamps every layer to a machine ceiling again before
  any bytes exist. The only knob a student may get is an engrave "darkness" slider inside a range the
  teacher allows.
- Runs on Cloudflare Workers + Containers, like its sibling
  [uploadmycode](https://github.com/daltonjfowler/uploadmycode). About $5/month plus pennies of usage.
- Written and maintained by one teacher, [Dalton Fowler](https://daltonjfowler.com). The code is
  kept boring on purpose.

## Screenshot

<img src="docs/screenshot-student.png" width="800" alt="The student page: title bar with the logo, Help, Teacher, theme toggle and Connect laser; toolbar with Open, Save, Import, Undo, Redo, Select all, Rotate, Group, Ungroup, Delete and zoom; a size bar for the selected file; Select, Text, Box, Circle, Line, Curve, Shapes and Pattern tools on the left; the laser bed with mm rulers showing an imported key tag with a black cut-through outline and hole, a blue engraved star and red marked lines; the three-colour palette and material chip; and the Layers and Laser panels on the right with Hide buttons and a step checklist">

The student page with an imported SVG key tag selected: a cut-through outline and hole, an engraved
star and marked lines. Before the class phrase is entered, the bed shows the browser's own sketch of
the file. There is a [dark mode](docs/screenshot-student-dark.png) too.

## What it does

- **Draw with three colours.** Black cuts through, red marks a line, blue engraves (fills the shape).
  SVG strokes/fills and DXF layers or colours are mapped the same way, and any other colour asks the
  student what it should do. The **Colours in your files** list shows every colour in every imported
  file, and each one can be changed (or skipped) at any time.
- **Laser-software-style workspace.** Open (start over with a file) and Import (add a file next to what's
  there), Text with seven fonts, Box, Circle, Line and Curve tools, a Shapes library (stars, hearts,
  sports balls, callouts, a potted plant...), a Pattern tool for rows and columns of copies, handles on
  every corner and side, a move grip, a size lock, Scale %, Undo/Redo, rotate, mm/cm/inch rulers, and
  mouse-wheel or pinch zoom. Up to 5000 parts in one design.
- **Selecting and grouping.** Click, Shift+click or Ctrl+A to select. Drag on empty bed for a box
  select: left to right picks parts wholly inside, right to left also picks parts it touches.
  **Group** ties parts together; **Ungroup** unties them, or splits a DXF or SVG into its separate
  shapes (an engraved shape keeps its holes). Shift+drag or the middle mouse button pans. Right-click
  opens a menu with the colours, Group, Ungroup, Rotate, Delete and Hide/Show.
- **Hide a colour.** Each layer has a Hide/Show button. It only changes the screen: hidden lines still
  run on the laser. While the server works on a change, an "Updating the laser lines..." sign shows.
- **Design files.** Designs autosave to the Chromebook's `localStorage`. **Save** writes the whole design
  as a `.uml` file that Open or Import brings back on any computer.
- **Runs in a safe order.** Engrave, then Mark, then Cut through, always last with all its passes,
  because parts that are cut free can shift. Inner cuts go before outer ones.
- **The laptop never starts the laser.** Send only loads the job; the student then presses Frame
  (beam off) and Start on the laser's own panel, so someone is always at the machine. The app has no
  Frame button of its own. By default Send stores the job in the laser's file list under a name of up
  to 8 letters (replacing a file with the same name); the teacher can switch it to a plain load that
  waits for Start. Send stays disabled until the student ticks "I will stay with the laser".
  STOP is sent from the browser, so it works even if the network is down (and Esc does the same).
- **No laser in the room?** **Download laser file** saves the finished job as a Ruida `.rd` file, with
  the teacher's limits already in it, for the laser's USB port. **Export for teacher** saves one zip with
  the `.uml` design, the `.rd` file when it is ready, and a `READ ME.txt` saying what state it was in.
- **A rolling class phrase.** The teacher sets today's phrase, with an expiry, from a `/teacher` page
  guarded by a secret key. The site opens for anyone, but nothing is processed without the phrase.
  Wrong tries lock out one device at a time, never the whole class (a school shares one IP).
- **Teacher page.** Materials and presets (materials named PVC, vinyl and other unsafe plastics are refused by name; a
  name check cannot know what a sheet really is), machine
  settings, the class phrase, and a warm-up button for the container.
- **Cost caps.** Scale-to-zero containers that sleep after 5 minutes, a per-Chromebook rate limit, a
  global ceiling, a 10 MB upload cap and a processing timeout.
- **Private by default.** No student accounts, no server-side storage of designs, self-hosted fonts,
  and a strict Content Security Policy, so student Chromebooks load nothing from third parties.

## The live site

<https://uploadmylaser.com> is the author's own instance, **for one school district's classrooms
only**. It is not a public service: processing needs that day's class phrase, so the site will not do
anything useful for anyone who is not in the room. It is up as a working reference, not as something
to sign up for.

**To use this, run your own copy.** [docs/SETUP.md](docs/SETUP.md) walks through it.

## How it works

```
Chromebook (Chrome)                          Cloudflare
  UI: arrange parts, preview   ── POST /api/process ──►  Worker: phrase, rate limit, validation,
  Web Serial ── USB ──► Ruida                            presets from KV
  (streams .rd bytes, STOP)    ◄── preview + .rd ──────  Container (Python): SVG/DXF/text → toolpaths
                                                         → hatch fill → Ruida .rd encoder
```

The Ruida `.rd` encoder follows MeerK40t's `rdjob.py` and is checked against known-good `.rd` files
in [test/golden/](test/golden/). See [docs/HARDWARE.md](docs/HARDWARE.md) for what has
been verified on the machine, and [PLAN.md](PLAN.md) for the full design.

## Commands

```sh
npm install
npm run typecheck   # tsc for the Worker and for web/
npm test            # node --test: Worker security and validation, frontend helpers
npm run test:py     # pytest: geometry, encoder, golden .rd files (needs container/requirements-dev.txt)
npm run dev:web     # Vite dev server, proxies /api to wrangler dev on :8787
npm run build       # vite build web -> public/
npm run icons       # redraw the logo PNGs from scripts/make-icons.mjs
npm run deploy      # build, then wrangler deploy (needs Docker running)
```

## Docs

- [docs/SETUP.md](docs/SETUP.md): **run your own copy.** Start here if this repo is new to you.
- [docs/DEPLOY.md](docs/DEPLOY.md): the operator manual for the live instance: daily routine, security,
  the teacher key, `ALLOWED_CIDRS`, local development.
- [docs/STUDENT_GUIDE.md](docs/STUDENT_GUIDE.md): one page to post next to the laser.
- [docs/TEST_PLAN.md](docs/TEST_PLAN.md): automated checks and the hardware test script.
- [docs/HARDWARE.md](docs/HARDWARE.md): what is known and verified about the Ruida protocol on this machine.
- [PLAN.md](PLAN.md): architecture and the plan the project was built from.
- [CREDITS.md](CREDITS.md): every open-source project this stands on.

## Safety

This software sends jobs to a Class 4 laser. It is a convenience, not a safety system. The laser's
physical emergency stop, lid interlock, fire safety equipment, ventilation, and an adult who is
trained on the machine remain the real safety measures. Never leave a running laser unattended, and
never laser PVC, vinyl, or other chlorine-containing materials. Use it at your own risk; see the
MIT license's warranty disclaimer.

## Trademarks and licensing

Ruida and Boss Laser are trademarks of their respective owners. This project is an independent tool written by a
teacher. It is not affiliated with, sponsored by, or endorsed by any of them. Those names are used
only to describe what this software is compatible with. The Ruida protocol handling was written from
public reverse-engineering notes and the MIT-licensed [MeerK40t](https://github.com/meerk40t/meerk40t)
project (see [CREDITS.md](CREDITS.md)).

This project's own code is MIT licensed. See [LICENSE](LICENSE).

## Credits

Built on other people's work. [CREDITS.md](CREDITS.md) lists every open-source project it uses, with
a link and license for each. None of those projects endorses this one. Made by
[Dalton Fowler](https://daltonjfowler.com), who also made
[uploadmycode](https://uploadmycode.com) and [teachChat.app](https://teachchat.app).
