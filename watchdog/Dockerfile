FROM node:22.23.3-slim
WORKDIR /app
COPY watchdog.mjs dashboard.html ./
ENV NODE_ENV=production
CMD ["node", "watchdog.mjs"]
