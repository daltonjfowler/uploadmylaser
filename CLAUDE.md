# CLAUDE.md

Kid-safe Ruida laser sender. Read PLAN.md first. Hardware facts live in docs/HARDWARE.md. Treat
anything not marked verified there as a guess.

## Layout
- `shared/contracts.ts`: the TS contracts. **`container/app/models.py` mirrors them (pydantic,
  camelCase aliases). Change both together.**
- `src/worker.ts`: Worker: KV presets, phrase gate, teacher key, forwards to `LaserContainer`.
- `container/app/`: FastAPI. `geometry/` (svg/dxf/text import, placement, hatch, ordering),
  `ruida/` (swizzle, encoder, decoder), `pipeline.py` wires it together.
- `web/`: Vite multi-page (index, teacher/, serial-test). No framework. Keep the bundle small, since
  Chromebooks are slow. `workspace.ts` is the canvas, `main.ts` the app state, `shapes.ts` draws Box/Circle as SVG.
- A design is a list of **parts** (file or text). Each part's placement puts its **top-right corner** at
  (xMm, yMm) after scale/rotate. Files go as multipart `file0..fileN`, matched by `fileIndex`.

## Safety invariants (never break these)
1. Students never send power or speed. The Worker whitelists request fields and resolves the
   Material from KV.
2. `ruida/encoder.clamp_settings` clamps every layer to `absoluteMaxPowerPct` / `minSpeedMmS`.
   Don't bypass it.
3. STOP (`D8 01`, swizzled) is sent from the browser and must not depend on the network.
4. Banned materials (PVC, vinyl, …) are refused in `validateMaterials`.
5. Cut through always runs last, with all its passes (`RUN_ORDER` in `ruida/encoder.py`). Parts that are cut
   free can shift, so nothing may run after them.
6. `E8 00` deletes controller files, and `E8 00 00 00 ...` deletes **all** of them. The only code that may
   build it is `deleteOneFile` in `web/src/ruida/panel.ts`: one slot (never 0), used only by
   `LaserLink.sendToPanel` to replace a file with the same name, after re-reading that slot. The container
   never emits any `E8` command (`test_encoder_never_emits_file_commands`).

## Ruida notes
- The RDC6445S uses swizzle magic 0x88. USB is an FTDI FT245R FIFO (VID 0403, PID 6001): no ACK, no
  checksum, baud ignored (per MeerK40t `usb_transport.py`). Verify on hardware.
- The encoder follows MeerK40t `rdjob.py` (MIT). When in doubt, diff against `test/golden/*.rd`
  with `python -m app.ruida.decoder`.
- Coordinates on the wire are µm from the machine home corner. The bed UI uses a top-left origin,
  and `to_machine()` flips axes per `MachineConfig.origin`.

## Commands
`npm run typecheck`, `npm run test:py`, `npm run dev` (Docker required), `npm run deploy`.

## Style
Match the existing code. Short comments only where the why isn't obvious. Student-facing error
strings are plain, friendly sentences.
