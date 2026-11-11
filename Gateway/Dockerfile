FROM node:22.23.3-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 8080

CMD ["node", "server.js"]
