# QC upload + scoring app: Node HTTP server that shells out to a Python scorer.
# Needs BOTH runtimes in one image — Node 20 base, plus system Python 3 + pip deps.
FROM node:20-slim

# Python 3 (the scorer) — node:slim is Debian-based, so apt is available.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first (better layer caching).
COPY requirements.txt ./
# Debian's pip is "externally managed"; --break-system-packages installs globally,
# which is what we want inside a container.
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# The Node side is zero-dependency (built-in http). Copy the app.
COPY . .

# score.py is invoked as `python3`; make that explicit for the server.
ENV PYTHON_BIN=python3
# Render provides $PORT; default to 3000 locally.
ENV PORT=3000
EXPOSE 3000

# Health: GET /health -> {"ok":true}
CMD ["node", "bin/serve.js"]
