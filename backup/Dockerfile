FROM alpine:3.21
# sqlite: copia consistente de nokia.db · tar (GNU): --exclude/--warning · tzdata: hora local
RUN apk add --no-cache sqlite tar tzdata
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
ENV TZ=Europe/Madrid
CMD ["backup.sh", "daemon"]
