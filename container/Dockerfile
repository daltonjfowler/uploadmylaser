# Pinned by digest (the multi-arch index of python:3.12-slim on 2026-09-27), so a rebuild can't pick up a
# different base. To update: docker pull python:3.12-slim, then docker inspect --format '{{.RepoDigests}}'.

# --- DWG -> DXF (beta): LibreDWG's dwg2dxf, built from the GNU release, pinned by sha256 ---------------
# GPL-3.0, run as a separate program by app/dwg.py (CREDITS.md). Only the one static binary is kept.
# To update: change the version and the hash together (sha256sum of the .tar.xz from ftp.gnu.org).
FROM python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f AS dwg
ARG LIBREDWG=0.14
ARG LIBREDWG_SHA256=62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config xz-utils curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Downloaded in a RUN (cached by its text), not ADD <url>: ADD asks the server on every build, so a GNU
# outage failed every deploy (2026-10-06). Any mirror will do: the sha256 below is what is trusted.
RUN cd /tmp && for m in https://ftpmirror.gnu.org https://mirrors.kernel.org/gnu https://ftp.gnu.org/gnu; do \
      curl -fsSL --retry 2 --connect-timeout 20 -o libredwg-${LIBREDWG}.tar.xz "$m/libredwg/libredwg-${LIBREDWG}.tar.xz" && break; \
    done \
 && echo "${LIBREDWG_SHA256}  libredwg-${LIBREDWG}.tar.xz" | sha256sum -c - \
 && tar xf libredwg-${LIBREDWG}.tar.xz && cd libredwg-${LIBREDWG} \
 && ./configure --disable-shared --enable-static --disable-bindings --disable-docs --disable-python >/dev/null \
 && make -j"$(nproc)" -C src >/dev/null && make -j"$(nproc)" -C programs dwg2dxf >/dev/null \
 && strip programs/dwg2dxf && cp programs/dwg2dxf /usr/local/bin/dwg2dxf && dwg2dxf --version

# --- the processor ----------------------------------------------------------------------------------
FROM python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

# Fonts for the Text tool (ids in app/geometry/text_import.py and shared/contracts.ts TEXT_FONTS).
# DejaVu comes from Debian. The rest are OFL/Apache fonts from github.com/google/fonts, pinned to one
# commit and checked against sha256 below. To update: change GF_COMMIT and the hashes together.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
ARG GF=https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a
ADD ${GF}/ofl/anton/Anton-Regular.ttf \
    ${GF}/ofl/bungee/Bungee-Regular.ttf \
    ${GF}/apache/permanentmarker/PermanentMarker-Regular.ttf \
    ${GF}/ofl/pacifico/Pacifico-Regular.ttf \
    ${GF}/ofl/allertastencil/AllertaStencil-Regular.ttf \
    /usr/share/fonts/truetype/uml/
RUN cd /usr/share/fonts/truetype/uml && printf '%s\n' \
    'a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab  Anton-Regular.ttf' \
    'c4f5361ce120af3e6b9156d0bf379fa19cda2ea0cd18ac01fd99596c6bf66e3f  Bungee-Regular.ttf' \
    '28f82c8a7943cb8e9d599f8554da1d4fc75dbcf69b9885ad6c0611d20c6946c5  PermanentMarker-Regular.ttf' \
    '5b6c0d5334a7bf77dea52b975c5a0c408878c0f7115ed5b6fb151f634b7bf701  Pacifico-Regular.ttf' \
    '8c504d1be20768941ab04251a389ad82d5782d647fa1c4029c811dc5bc2abd59  AllertaStencil-Regular.ttf' \
    | sha256sum -c -

WORKDIR /srv
# Exact versions with hashes. The top of requirements.txt says how to regenerate it.
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements.txt

COPY app ./app
COPY --from=dwg /usr/local/bin/dwg2dxf /usr/local/bin/dwg2dxf

ENV PYTHONUNBUFFERED=1
EXPOSE 8080
# One uvicorn worker: it hands each job to a worker process with a time limit (app/runner.py).
# max_instances in wrangler.jsonc is the scaling knob.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--timeout-keep-alive", "30"]
