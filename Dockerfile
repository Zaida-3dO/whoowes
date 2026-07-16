FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Ledger lives on a mounted volume, not in the image.
ENV WHOOWES_DIR=/data
EXPOSE 8000
CMD ["node", "dist/http.js"]
