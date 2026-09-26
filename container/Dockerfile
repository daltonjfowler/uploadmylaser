FROM python:3.12-slim

# Fonts for the Text tool (ids in app/geometry/text_import.py and shared/contracts.ts TEXT_FONTS).
# DejaVu comes from Debian. The rest are OFL/Apache fonts from github.com/google/fonts.
# If a URL 404s (Google occasionally moves a family to a variable font), find the new path on GitHub.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
ARG GF=https://raw.githubusercontent.com/google/fonts/main
ADD ${GF}/ofl/anton/Anton-Regular.ttf \
    ${GF}/ofl/bungee/Bungee-Regular.ttf \
    ${GF}/apache/permanentmarker/PermanentMarker-Regular.ttf \
    ${GF}/ofl/pacifico/Pacifico-Regular.ttf \
    ${GF}/ofl/allertastencil/AllertaStencil-Regular.ttf \
    /usr/share/fonts/truetype/uml/

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV PYTHONUNBUFFERED=1
EXPOSE 8080
# One worker: max_instances in wrangler.jsonc is the scaling knob, not uvicorn workers.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--timeout-keep-alive", "30"]
