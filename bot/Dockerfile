FROM node:22-slim

# Install Playwright dependencies
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    fonts-noto-color-emoji fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json tsconfig.json ./
RUN npm install

# Install Playwright browser
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install chromium && chmod -R a+rx /ms-playwright

# Copy source and configs
COPY src/ ./src/
COPY tpa-configs/ ./tpa-configs/
RUN useradd --create-home bot && mkdir -p /app/screenshots && chown -R bot /app
USER bot

# Build TypeScript
RUN npm run build

# Health check
HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD node -e "console.log('ok')" || exit 1

CMD ["npm", "start"]
