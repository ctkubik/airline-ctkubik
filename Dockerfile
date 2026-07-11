# ---- Stage 1: build the Next.js frontend ----
# Same base image as the runtime stage so the apk nodejs version (and its
# native-module ABI) is identical in both stages: better-sqlite3 has no musl
# prebuilds and must be compiled against the exact Node version it runs on.
FROM python:3.13-alpine AS frontend-build

# nodejs+npm to build, make/g++ to compile better-sqlite3 (python3 is the base)
RUN apk add --update --no-cache nodejs npm make g++

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./
ENV NEXT_TELEMETRY_DISABLED=1
# The standalone output must be self-contained: fail the BUILD (not runtime)
# if Next's file tracing didn't bundle the native better-sqlite3 module.
RUN npm run build \
    && cp -r .next/static .next/standalone/.next/static \
    && if [ -d public ]; then cp -r public .next/standalone/public; fi \
    && node -e "require('/app/frontend/.next/standalone/node_modules/better-sqlite3')"

# ---- Stage 2: runtime ----
FROM python:3.13-alpine

ENV AUTO_SOUTHWEST_CHECK_IN_DOCKER=1 \
    PYTHONUNBUFFERED=1

# nodejs (runtime only, no npm), a matched chromium+chromedriver pair from the
# same repo snapshot, xvfb for the headed browser, supervisor as process manager
RUN apk add --update --no-cache \
    nodejs \
    chromium chromium-chromedriver \
    xvfb xauth \
    supervisor

WORKDIR /app

COPY worker/requirements.txt /app/worker/requirements.txt
RUN pip3 install --no-cache-dir -r /app/worker/requirements.txt

COPY --from=frontend-build /app/frontend/.next/standalone /app/frontend/.next/standalone
COPY worker/ /app/worker/
COPY supervisord.conf entrypoint.sh /app/
RUN chmod +x /app/entrypoint.sh && mkdir -p /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO /dev/null http://127.0.0.1:3000/api/health || exit 1

CMD ["/app/entrypoint.sh"]
