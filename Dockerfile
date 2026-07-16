FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
# --cache: the default /root/.npm trips over some overlayfs setups (QNAP hit
# "ENOENT ... File exists" in _cacache); a fresh cache dir sidesteps it.
RUN npm ci --no-audit --no-fund --cache /tmp/npm-cache

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Ledger lives on a mounted volume, not in the image.
ENV WHOOWES_DIR=/data
EXPOSE 8000
CMD ["node", "dist/http.js"]
