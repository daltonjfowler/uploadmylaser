# Hardware notes: Boss LS36 / Ruida RDC6445S

Record what has actually been **verified on the machine**. Anything else is a guess from other
people's reverse engineering.

| Fact | Value | Verified? | How |
|---|---|---|---|
| Controller | RDC6445S | ✅ (panel) | teacher read it off the controller |
| Swizzle magic | 0x88 | ✅ | golden file decodes, ends with D7, and the checksum matches exactly |
| File checksum `E5 05` = sum(unswizzled bytes before it) + 0xD7 | | ✅ | golden: stored 2459556 = computed |
| Command layout LightBurn uses | see "LightBurn layout" below | ✅ | decoded golden file. Encoder mirrors it |
| USB chip | FTDI FT245R, VID 0403 / PID 6001 | ☐ | serial-test.html port info |
| Baud | ignored (FIFO), sending 115200 | ☐ | replay works at 115200 |
| Flow control | hardware (RTS/CTS) | ☐ | replay works; try "none" if it stalls |
| ACK / reply bytes over USB | none expected | ☐ | serial-test.html RX log |
| Job starts on receive, or waits for panel Start? | waits for Start on the panel | ✅ | teacher, 2026-09-24, streamed from the app on a Windows ThinkPad |
| Home / origin corner | top-right (guess) | ☐ | jog to home, then note the corner |
| Bed size | 914 × 609 mm (36" × 24") | ☐ | spec sheet / LightBurn device settings |
| STOP (D8 01) aborts a running job | ? | ☐ | send a long job, press STOP |
| Frame (move-only job) traces without firing | ? | ☐ | |

## Phase 0 procedure
1. **In LightBurn (Windows laptop):** make each test job at low power on cardboard, then use
   **File → Save RD file** into `test/golden/`. Fill in the table in `test/golden/README.md`.
2. **Deploy from your home computer** (`npm run deploy`). Never run a local server on the school laptop.
3. **On a Chromebook in Chrome:** open `https://<deployed-site>/serial-test.html`, plug in the laser, Connect, load `square-cut.rd`,
   check the summary says "ends with D7", then Send. Stay at the machine.
4. Copy the log into this file and fill in the table above.

## Job file layout (from a 2-layer class nameplate job, cut + line; the file itself is not in this repo)
Decode it yourself: `powershell -ExecutionPolicy Bypass -File scripts\rddecode.ps1 -File "test\golden\<file>.rd"`

- Header: `D8 11` (REF_POINT_1, not D8 10), no `E6 01`. Then `F0`, `F1 02 00`, `D8 00`, `E7 06`, `E7 38`.
  Bounding boxes are **(min x, min y) / (max x, max y)**. MeerK40t's encoder swaps the x values; the class files do not.
- Per-layer part table (`C9 04`, `C6 31/32/41/42`, `CA 06` colour as 0xRRGGBB, `CA 41`, `E7 52/53/61/62`), then `CA 22`.
- An `F1 00`…`F2 07` "element" block with a name. **We omit it**, since MeerK40t works without it.
- `E7 37` and `E7 08` carry the design **width/height**, not MeerK40t's magic constants.
- Each layer starts `CA 01 00`, `CA 02 n`, `CA 01 30`, `CA 01 10`, `CA 01 13` (air on), `C9 02`, `C6 50`,
  `C6 51`, `C6 01/02/21/22`, `CA 03 01`, `CA 10 00`. There's no block-end between layers.
- Travel is **always `88` absolute**. Cuts are relative when short.
- Tail: `EB`, `E7 00`, `DA 01 06 20 …` (**we omit it**: it sets a controller variable, meaning unknown), `E5 05` checksum, `D7`.
- Golden job settings: layer 0 at 20 mm/s, 50–62.5 % (cut); layer 1 at 75 mm/s, 20 % (line).
  Laser-2 power fields are written at 20 % even on a single-tube machine.
- ✅ **Absolute Coords** (`20mm_absolute.rd`) = `D8 10` + `E6 01`. The nameplate file's `D8 11` was a different Start From mode.
- ✅ **Array fields** (from `20mm_absolute.rd`, square at 15..35 × 29..49): `E7 23` = min corner, `E7 37` = max corner,
  `E7 08` = 1, 1, **width, height**. The nameplate file started at 0,0, which hid the difference.
- ✅ **Passes** repeat the path inside the same layer (2 passes = the square drawn twice).
- ✅ **Fill engrave** (`20mm_fill.rd`, 200 mm/s, 15 %): `CA 41 part 02` (work mode 2 = scan), layer starts `CA 01 01`,
  has `C6 12`/`C6 13` delays, no `C6 50/51` or `CA 10`, and ends with an extra `E7 00`. Motion is horizontal `CUT_ABS`
  lines 0.1 mm apart, alternating direction, joined by `MOVE_REL_Y`. It's plain vector lines, so our hatch output fits.
- ✅ Teacher confirmed the box coordinates were read correctly (square at 15..35 × 29..49).
- **Teacher's workflow (the default):** machine origin **top-right**, and jobs **anchored to the design, not to
  the true machine origin**. The design's top-right corner starts at the laser head, which is what the nameplate
  file does (`D8 11`, bbox from 0,0). `jobOriginMode: "relative"`. Absolute bed placement stays available on
  the teacher page.
- **Verify on the first test:** does `D8 11` start at the **current head position**, or at a stored **user
  origin** (the panel's Origin key)? Jog the head, Frame a job, and see where it traces. If it goes to a stored
  origin instead, students set it with the panel's Origin key, or we switch to `D8 12` (REF_POINT_0).

## Wanted: "Send to panel" (the class's usual workflow)

Normally the class uses LightBurn's **Send**, which stores the job in controller memory, then **frames and
starts from the touchscreen**. That's a good safety gate for kids, because someone has to be at the machine.
The app currently streams the job the way LightBurn's **Start** does. It also has Frame/Send buttons, which
are extras.

### Send to panel: the Ruida file commands
From MeerK40t's Ruida emulator (`meerk40t/ruida/emulator.py`, MIT), not yet checked on the class RDC6445S:

- **Store a job:** `E8 02` (file transfer), then `E7 01 <name> 00` (file name), then the job itself.
  The job's `E5 05` checksum (sum of its plain bytes + `0xD7`) does not include the name packet.
- **Names:** the controller lists them in capitals, at most 8 characters. The app sends only A-Z, 0-9,
  space and `-`.
- **File list (read only):** file count at memory `0x0205` (`DA 00 02 05`, reply `DA 01 02 05 <value>`),
  then `E8 01 <n>` per file (reply `E8 01 <n> <name> 00`).
- ⚠️ **Delete:** `E8 00 <n> <n>` deletes file n. `E8 00 00 00 00 00` deletes **every** file. The app only
  ever deletes one file, by slot, after reading that slot's name again (web/src/ruida/panel.ts).
- To check on the real laser: that the panel lists the file, what it does with a duplicate name, and whether
  it answers the read commands over USB.

Also record at the laser: when the app streams a job over USB, does it **run immediately** or **appear on the
panel waiting for Start**? If it waits, the class workflow already works as-is.

## Teacher's tested settings (2026-09-23), seeded as "Masonite / Luan" (the only preset for now)
| Colour | Op | Speed | Power | Passes |
|---|---|---|---|---|
| Black | Cut through | 20 mm/s | 55 % | 2 |
| Red | Mark | 75 mm/s | 20 % | 1 |
| Blue | Engrave (fill, 0.1 mm lines) | 200 mm/s | 15 % default, **students choose 15–35 %** | 1 |

## Log
(paste serial-test logs here)
