# Pinned by digest (the multi-arch index of python:3.12-slim on 2026-10-25, Python 3.12.15), so a rebuild can't pick up a
# different base. To update: docker pull python:3.12-slim, then docker inspect --format '{{.RepoDigests}}'.

# --- DWG -> DXF (beta): LibreDWG's dwg2dxf, built from the GNU release, pinned by sha256 ---------------
# GPL-3.0, run as a separate program by app/dwg.py (CREDITS.md). Only the one static binary is kept.
# To update: change the version and the hash together (sha256sum of the .tar.xz from ftp.gnu.org).
FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704 AS dwg
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
FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704

# Fonts for the Text tool (ids in app/geometry/text_import.py and shared/contracts.ts TEXT_FONTS).
# DejaVu and Liberation come from Debian (Liberation stands in for Arial, Times New Roman and Courier New
# in AutoCAD text: STAND_INS in app/geometry/dxf_import.py). The rest are OFL/Apache fonts from
# github.com/google/fonts, pinned to one commit and checked against sha256 below. To update: change
# GF_COMMIT and the hashes together.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
ARG GF=https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a
ADD ${GF}/ofl/anton/Anton-Regular.ttf \
    ${GF}/ofl/bungee/Bungee-Regular.ttf \
    ${GF}/apache/permanentmarker/PermanentMarker-Regular.ttf \
    ${GF}/ofl/pacifico/Pacifico-Regular.ttf \
    ${GF}/ofl/allertastencil/AllertaStencil-Regular.ttf \
    ${GF}/ofl/bebasneue/BebasNeue-Regular.ttf \
    ${GF}/ofl/staatliches/Staatliches-Regular.ttf \
    ${GF}/ofl/archivoblack/ArchivoBlack-Regular.ttf \
    ${GF}/ofl/russoone/RussoOne-Regular.ttf \
    ${GF}/ofl/passionone/PassionOne-Regular.ttf \
    ${GF}/ofl/titanone/TitanOne-Regular.ttf \
    ${GF}/apache/luckiestguy/LuckiestGuy-Regular.ttf \
    ${GF}/ofl/bowlbyonesc/BowlbyOneSC-Regular.ttf \
    ${GF}/apache/ultra/Ultra-Regular.ttf \
    ${GF}/ofl/alfaslabone/AlfaSlabOne-Regular.ttf \
    ${GF}/ofl/abrilfatface/AbrilFatface-Regular.ttf \
    ${GF}/ofl/shrikhand/Shrikhand-Regular.ttf \
    ${GF}/ofl/rubikmonoone/RubikMonoOne-Regular.ttf \
    ${GF}/ofl/bangers/Bangers-Regular.ttf \
    ${GF}/apache/chewy/Chewy-Regular.ttf \
    ${GF}/ofl/cherrybombone/CherryBombOne-Regular.ttf \
    ${GF}/ofl/creepster/Creepster-Regular.ttf \
    ${GF}/ofl/monoton/Monoton-Regular.ttf \
    ${GF}/ofl/bungeeinline/BungeeInline-Regular.ttf \
    ${GF}/ofl/bungeeshade/BungeeShade-Regular.ttf \
    ${GF}/ofl/righteous/Righteous-Regular.ttf \
    ${GF}/ofl/audiowide/Audiowide-Regular.ttf \
    ${GF}/ofl/pressstart2p/PressStart2P-Regular.ttf \
    ${GF}/apache/specialelite/SpecialElite-Regular.ttf \
    ${GF}/ofl/pirataone/PirataOne-Regular.ttf \
    ${GF}/ofl/unifrakturmaguntia/UnifrakturMaguntia-Book.ttf \
    ${GF}/ofl/lobster/Lobster-Regular.ttf \
    ${GF}/apache/satisfy/Satisfy-Regular.ttf \
    ${GF}/ofl/greatvibes/GreatVibes-Regular.ttf \
    ${GF}/ofl/kaushanscript/KaushanScript-Regular.ttf \
    ${GF}/apache/yellowtail/Yellowtail-Regular.ttf \
    ${GF}/ofl/sacramento/Sacramento-Regular.ttf \
    ${GF}/apache/rocksalt/RockSalt-Regular.ttf \
    ${GF}/ofl/gloriahallelujah/GloriaHallelujah.ttf \
    ${GF}/ofl/caveatbrush/CaveatBrush-Regular.ttf \
    ${GF}/ofl/sedgwickavedisplay/SedgwickAveDisplay-Regular.ttf \
    ${GF}/ofl/amaticsc/AmaticSC-Bold.ttf \
    ${GF}/ofl/blackopsone/BlackOpsOne-Regular.ttf \
    ${GF}/ofl/sairastencilone/SairaStencilOne-Regular.ttf \
    ${GF}/ofl/stardosstencil/StardosStencil-Bold.ttf \
    ${GF}/ofl/wallpoet/Wallpoet-Regular.ttf \
    /usr/share/fonts/truetype/uml/
RUN cd /usr/share/fonts/truetype/uml && printf '%s\n' \
    'a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab  Anton-Regular.ttf' \
    'c4f5361ce120af3e6b9156d0bf379fa19cda2ea0cd18ac01fd99596c6bf66e3f  Bungee-Regular.ttf' \
    '28f82c8a7943cb8e9d599f8554da1d4fc75dbcf69b9885ad6c0611d20c6946c5  PermanentMarker-Regular.ttf' \
    '5b6c0d5334a7bf77dea52b975c5a0c408878c0f7115ed5b6fb151f634b7bf701  Pacifico-Regular.ttf' \
    '8c504d1be20768941ab04251a389ad82d5782d647fa1c4029c811dc5bc2abd59  AllertaStencil-Regular.ttf' \
    '08e4623805102d819f58601e46e345648846075e363b2ceb23313c2d1c83ec73  BebasNeue-Regular.ttf' \
    '8395212aa4c6c3534bd39a745d956305ff080c3f3ed73ba61e4fbaae951e55cc  Staatliches-Regular.ttf' \
    'dd9a89a019b4849f66ab75455fe7bdf931311042cbb0f0f97acc061539703180  ArchivoBlack-Regular.ttf' \
    'bc0abcc660bd8b7ad3000ecb2898a27c58a29a50f7ec81652fa12e75148d09df  RussoOne-Regular.ttf' \
    '86fea5001e5d751cf5696f0ecd4754db80918adbb12658add959f5bcdc92b09b  PassionOne-Regular.ttf' \
    '563ff6de179bbd44bcd7d2a6c448d6dc3bf935834237cf1250e506e65cd86ff1  TitanOne-Regular.ttf' \
    'cfbdd68a039f92df51cf3721506af6242e64594c6325fe0bedbeff3fe385d980  LuckiestGuy-Regular.ttf' \
    'dc9f2325fb6bab327c26619a752b274b8f0f4022756d896450911e885609f071  BowlbyOneSC-Regular.ttf' \
    '9ee63cffbc379e5d4eb5fed6a0b94b770da919497e5cba4a227a6393dae0939e  Ultra-Regular.ttf' \
    '28664afa698a3393bd5a29eec750230a0645c5301d62200e5f2d3a027fb2299d  AlfaSlabOne-Regular.ttf' \
    '5971d4a3758a922a9fedc7f6fb825a96341a2e718c45a4b2c9a6b417c8c4dbe9  AbrilFatface-Regular.ttf' \
    '8ba32f6d6a96fb8dbc92fc1acfbc4d2123d5348063d89b2c3dd784e7afcb81af  Shrikhand-Regular.ttf' \
    'b22624b6a36e543e942106edfccd198c50b57b65b924bfe02a6f0a5699429e6b  RubikMonoOne-Regular.ttf' \
    '4160a7311de9342674cce9160cde9fcbb30f48190397d86ff1b70b455af65824  Bangers-Regular.ttf' \
    '7cf75ea288f82fd20badea8ab4da7a656a96a7277c170811e813b3d3d6294147  Chewy-Regular.ttf' \
    '9596c6793eb0335057d655b13751ce7ccb50ef0cd15cb52c58465fb62de2bb8f  CherryBombOne-Regular.ttf' \
    '402aeb734586c74aecd3dbdc454589b1fb12e2e1c71f782fd019ae68066d9f44  Creepster-Regular.ttf' \
    '951c4cea65ffede784a7c9672feec5d329a7e1e12216c42d53ecf36c90d04dea  Monoton-Regular.ttf' \
    '5a07361627376971fa195e8500ec0fc5e0daf7df2f94ba8eb30d1b10ed7e0375  BungeeInline-Regular.ttf' \
    '665c626082682b462f4e696308eafa7071c114da8f8ff3fb73a289c7ff7df482  BungeeShade-Regular.ttf' \
    '2ffb3fe5c27d7e6571210b800448c4e234e651b46c6b4426c1bb567e5341348a  Righteous-Regular.ttf' \
    'c7c0f2b0f6fad8c623e31772ce79f94a4edb9321ffce9fce978ea892d20ae730  Audiowide-Regular.ttf' \
    '034c77f1f05ec89421e4a63f0e3a4ca1ecf852cc6d2bf611f126f275728e017d  PressStart2P-Regular.ttf' \
    'a776fcb4ceb8bdf03e2967688ebdad42680de5b91a7e62c17e718ae212d14bc4  SpecialElite-Regular.ttf' \
    '5347a2e155589ecf667d4b766613c8ee003edde9f83717fd24c09599a4b1ecc0  PirataOne-Regular.ttf' \
    'd64afc0547059dd2e4a78da48bda0aba0a9901be58c7f8c201a8b2b6b4492cc8  UnifrakturMaguntia-Book.ttf' \
    'd6568e697fd50cedc0be04d8aae4127fe95add607e7bff954ca88604be80c205  Lobster-Regular.ttf' \
    '55bb141a0a23a32278d5fa7fd2e853824faa173b94774660ebeddb106be07c80  Satisfy-Regular.ttf' \
    '8d509802186f1b51572531ecf313e8098f9a5bfdfaca93f0c9b34467f9982d15  GreatVibes-Regular.ttf' \
    '6d8d379d9bba98178bee476d68114c8f83812c18005ecccf679e70f60e03d8f6  KaushanScript-Regular.ttf' \
    '3e06841b13000975f3cc38aa84e326e601a4378a4c52d50b5e9fee3598c5d236  Yellowtail-Regular.ttf' \
    '9341fda10adbfeb7efc94302b34507a3e227d7e7f5c432df3f5ac8753ff73d24  Sacramento-Regular.ttf' \
    'c5421d1ced1949488f29d11b75b7ef967abe2d870f816246bf18fdc0f3e29c96  RockSalt-Regular.ttf' \
    'eb59f2762ce8785a292bebb2af3b3e6aa21454913d791f5f25441d1d57ead9fc  GloriaHallelujah.ttf' \
    'e565bd7bffd895ca64f8d1cb77c816b9b38d9c010246386a07c9648592f6f282  CaveatBrush-Regular.ttf' \
    '3b9c295a146bafb93c8a12c1dde38a2fe47512777daf1458825e291752469a38  SedgwickAveDisplay-Regular.ttf' \
    'd367beadee66efbb657d24d3d8f30f3b60633e9d5c8ded7385541cf775cabb4d  AmaticSC-Bold.ttf' \
    '282a825b5f294377387e3969f765408157dbea8da0f5d0aae68c6bc704b145b3  BlackOpsOne-Regular.ttf' \
    '781496fdaf8e04cf6741b31025f6b4ba84f66021b097a8e0d85cbea2180cf223  SairaStencilOne-Regular.ttf' \
    '6b15f50b1b358512d922b5f11937af17e90704587e1d7fb009f1715d2d5dfa74  StardosStencil-Bold.ttf' \
    '0d8dc36abe195fa455a5a9f60a29f0aa29c7404bf880a67ec71f047dabefb02b  Wallpoet-Regular.ttf' \
    | sha256sum -c -  && chmod 0644 *.ttf

WORKDIR /srv
# Exact versions with hashes. The top of requirements.txt says how to regenerate it.
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements.txt

COPY app ./app
COPY --from=dwg /usr/local/bin/dwg2dxf /usr/local/bin/dwg2dxf

# Run as a plain user, not root: dwg2dxf parses untrusted files, and so does everything else in here.
# It can read the app and the fonts (root-owned, world-readable: ADD <url> makes files 0600, hence the
# chmod above) and write only to /tmp (DWG temp folders, ezdxf's cache in $HOME). dwg2dxf runs as this
# same user: handing it to a second user would need root again.
RUN useradd --uid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin uml
USER 10001:10001

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080
# One uvicorn worker: it hands each job to a worker process with a time limit (app/runner.py).
# max_instances in wrangler.jsonc is the scaling knob.
# --timeout-graceful-shutdown: on SIGTERM (sleep, idle cap) exit within 5 s even if a request is stuck. Without it
# uvicorn waits for open requests forever and the container keeps billing (src/idle-cap.ts).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--timeout-keep-alive", "30", "--timeout-graceful-shutdown", "5"]
