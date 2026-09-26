# Test plan

Automated checks run on the home machine. The hardware checks need the real laser, a Chromebook,
and cardboard. Fill in the result column and copy anything surprising into docs/HARDWARE.md.

## Automated (before every deploy)
```
npm run typecheck
npm test             # Worker gate, headers, rate limits, request validation, swizzle
npm run test:py      # geometry, encoder, golden .rd files, pipeline
docker build -t uml container   # proves the image and its fonts still build
```

## After deploy (any browser)
| Check | Expect | Result |
|---|---|---|
| `http://uploadmylaser.com` | 301 to `https://uploadmylaser.com/` | |
| `https://www.uploadmylaser.com/x?y=1` | 301 to `https://uploadmylaser.com/x?y=1` | |
| Response headers on `/` | HSTS, CSP, `permissions-policy` with `serial=(self)`, `x-frame-options: DENY` | |
| `/api/process` with no phrase | 403 "The laser is closed…" | |
| `/teacher/` with a wrong key | "Wrong teacher key." after a short pause | |
| Teacher: set phrase, warm up | "Ready." | |
| Student: phrase, material, Text "Hi" | preview, estimate, no errors | |

## Hardware (Chromebook + laser, cardboard, low power)
Stay at the machine with the lid closed for every job.

| # | Job | Expect | Result |
|---|---|---|---|
| 1 | `serial-test.html` replay of `test/golden/20mm_absolute.rd` | cuts the square; fill in docs/HARDWARE.md table | |
| 2 | Connect from the student page | port picker shows the FTDI device (0403:6001) | |
| 3 | Frame a 50 mm box | head traces the box, laser stays off | |
| 4 | Does Frame start at the **current head position**? | yes → `D8 11` is right. No → see HARDWARE.md | |
| 5 | Send a 20 mm box, Cut through | runs immediately, or waits for Start on the panel (record which) | |
| 6 | 30 mm circle | round, closes cleanly | |
| 7 | Box with a circle inside, both Cut through | inner circle is cut **before** the outer box | |
| 8 | Text "Hi", Engrave | filled letters, holes in letters stay empty | |
| 9 | Text in Stencil, Cut through | letters keep their middles | |
| 10 | Engrave + Mark + Cut in one design | runs Engrave → Mark → Cut, cut passes last | |
| 11 | DXF with arcs and a spline | smooth curves, right size | |
| 12 | Open, then Import a second file | both parts land where shown, relative spacing kept | |
| 13 | Design near each edge of the material | Frame shows it before cutting | |
| 14 | STOP during a long job | laser stops. Record whether the head parks | |
| 15 | Unplug USB mid-job | page says "Laser not connected"; laser behaviour recorded | |
| 16 | Cold start (container asleep >10 min) | first preview takes a few seconds, then works | |
| 17 | Student power slider (Engrave 15 → 35 %) | visibly darker at 35 % | |
