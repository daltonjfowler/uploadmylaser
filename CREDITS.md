# Credits

uploadmylaser is a thin shell around other people's work. This file lists the open-source projects
it stands on, so you can go find them, read their code, and support them. Being credited here is not
affiliation: none of these projects endorses this one.

Versions are the ones installed when this file was written (`package-lock.json`,
`container/requirements.txt` ranges resolved in the image).

## The Ruida protocol

The encoder follows MeerK40t (MIT). The other three are protocol documents, used as references
only: no code from them is copied here.

- **MeerK40t** (MIT): <https://github.com/meerk40t/meerk40t>. The Ruida command set, number encoding,
  swizzle, and job header sequence in `container/app/ruida/` follow `meerk40t/ruida/rdjob.py`, and the
  USB behaviour follows `usb_transport.py`.
  The Send to panel file commands (`web/src/ruida/panel.ts`) follow `meerk40t/ruida/emulator.py`.
  MeerK40t's licence (MIT, "Copyright (c) 2021 meerk40t") is reproduced in full in
  `web/public/licenses.txt`, served at https://uploadmylaser.com/licenses.txt.
- **EduTech Wiki: Ruida**: <https://edutechwiki.unige.ch/en/Ruida>. Protocol notes.
- **jnweiger/ruida-laser** (GPL-2.0 code, not used): <https://github.com/jnweiger/ruida-laser>. `doc/protocol.md`.
- **kkaempf/ruida**: <https://github.com/kkaempf/ruida>. Serial protocol and command documentation.

## The processing container (Python)

| Project | Version | License | Used for |
|---|---|---|---|
| [FastAPI](https://github.com/fastapi/fastapi) | 0.141 | MIT | the HTTP service |
| [Uvicorn](https://github.com/encode/uvicorn) | 0.53 | BSD-3-Clause | the server |
| [Pydantic](https://github.com/pydantic/pydantic) | 2.13 | MIT | the request/response contracts |
| [svgelements](https://github.com/meerk40t/svgelements) | 1.9 | MIT | SVG parsing: transforms, units, CSS colours |
| [ezdxf](https://github.com/mozman/ezdxf) | 1.4 | MIT | DXF parsing |
| [Shapely](https://github.com/shapely/shapely) | 2.1 | BSD-3-Clause | engrave fill hatching with holes |
| [fontTools](https://github.com/fonttools/fonttools) | 4.66 | MIT | text to outlines |
| [Python](https://www.python.org) 3.12 (`python:3.12-slim` image) | | PSF | the runtime |

## Fonts

- **DejaVu Sans / Serif** (Bitstream Vera license): <https://dejavu-fonts.github.io>, installed in the
  container from Debian.
- **Anton, Bungee, Pacifico, Allerta Stencil** (SIL OFL 1.1) and **Permanent Marker** (Apache 2.0),
  from [Google Fonts](https://github.com/google/fonts): downloaded into the container image, and
  self-hosted for the font picker via [Fontsource](https://fontsource.org) (MIT). Their licence texts
  are in `web/public/licenses.txt`.

## The web app and Worker

| Project | Version | License |
|---|---|---|
| [Vite](https://github.com/vitejs/vite) | 8.2 | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) | 5.9 | Apache-2.0 |
| [Wrangler](https://github.com/cloudflare/workers-sdk) | 4.127 | MIT OR Apache-2.0 |
| [@cloudflare/containers](https://github.com/cloudflare/containers) | 0.3.7 | MIT OR Apache-2.0 |

## Architecture

Adapted from **uploadmycode**, by the same author: <https://github.com/daltonjfowler/uploadmycode>.
The Worker's security headers, rate limits, teacher-key guard and class phrase are ports of its code.
