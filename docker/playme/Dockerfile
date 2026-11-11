# PlayME con ffmpeg ya instalado en la imagen. Antes se hacía «apt-get install ffmpeg» en
# cada arranque del contenedor, y con la red lenta eso tardaba minutos. El código sigue
# montado como volumen desde /home/alanxio/NetBeansProjects/PlayME/server (ver compose).
FROM node:22.23.3-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# npm install solo si package.json / package-lock.json han cambiado desde la última vez.
CMD ["sh", "-c", "if [ ! -f node_modules/.package-lock.json ] || [ package.json -nt node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then npm install --no-audit --no-fund && touch node_modules/.package-lock.json; fi && exec npm start"]
