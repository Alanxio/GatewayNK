#!/bin/sh
# Copias de seguridad de GateWayNK / NokiaMSN.
#
#   backup.sh daemon   bucle: una copia al día a BACKUP_AT (y al arrancar si la última
#                      tiene más de 24 h)
#   backup.sh now      una copia ya (lo usa «expose.sh backup»)
#
# Qué se copia (lo que no se puede regenerar):
#   NokiaMSN/data/nokia.db            con «sqlite3 .backup» (seguro con la app en marcha)
#   NokiaMSN/data/tls/                la raíz instalada en el Nokia (ca.key) y certificados
#   NokiaMSN/data/trusted_devices.json, NokiaMSN/data/avatars/
#   NokiaMSN/.wwebjs_auth/            sesión de WhatsApp, SIN las cachés de Chromium
#   NokiaMSN/.env, GateWayNK/Gateway/.env
# public/media no se copia (se borra sola con la limpieza diaria); BACKUP_MEDIA=true la añade.
#
# Restaurar (con los contenedores parados: expose.sh stop):
#   tar -xzf diaria-AAAA-MM-DD_HHMM.tar.gz -C /home/alanxio/Documentos
# Los ficheros contienen secretos: se guardan con permisos 600 a nombre de BACKUP_UID.
set -eu

DEST=/backups
SRC=/src
STATUS="$DEST/last-status.json"
BACKUP_AT="${BACKUP_AT:-04:30}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
OWNER="${BACKUP_UID:-1000}:${BACKUP_GID:-1000}"

log() { echo "$(date '+%H:%M:%S') [backup] $*"; }

write_status() { # $1 = ok (true/false), $2 = fichero, $3 = bytes, $4 = segundos, $5 = error
  printf '{"ok":%s,"at":"%s","file":"%s","bytes":%s,"seconds":%s,"error":"%s"}\n' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "${3:-0}" "${4:-0}" \
    "$(printf '%s' "${5:-}" | tr '"\\\n' "'/ " | cut -c1-300)" > "$STATUS.tmp"
  mv "$STATUS.tmp" "$STATUS"
  chown "$OWNER" "$STATUS" 2>/dev/null || true
}

run_backup() {
  start=$(date +%s)
  stamp=$(date +%Y-%m-%d_%H%M)
  work=$(mktemp -d)
  out="$DEST/.parcial-$stamp.tar.gz"
  trap 'rm -rf "$work" "$out"' EXIT

  mkdir -p "$DEST"
  chown "$OWNER" "$DEST" 2>/dev/null || true
  chmod 700 "$DEST"

  # 1. Base de datos: copia consistente aunque NokiaMSN esté escribiendo, y comprobada.
  mkdir -p "$work/NokiaMSN/data"
  if ! sqlite3 "$SRC/NokiaMSN/data/nokia.db" ".backup '$work/NokiaMSN/data/nokia.db'" 2>"$work/err"; then
    fail "$start" "sqlite3 .backup: $(cat "$work/err")"; return 1
  fi
  if [ "$(sqlite3 "$work/NokiaMSN/data/nokia.db" 'PRAGMA integrity_check;' 2>&1)" != "ok" ]; then
    fail "$start" "la copia de nokia.db no pasa integrity_check"; return 1
  fi

  # 2. El resto. tar código 1 = «un fichero cambió mientras se leía» (Chromium escribiendo):
  #    se acepta; 2 o más es un error de verdad.
  set -- NokiaMSN/data/tls NokiaMSN/.env GateWayNK/Gateway/.env
  for optional in NokiaMSN/data/trusted_devices.json NokiaMSN/data/avatars NokiaMSN/.wwebjs_auth; do
    [ -e "$SRC/$optional" ] && set -- "$@" "$optional"
  done
  if [ "${BACKUP_MEDIA:-false}" = "true" ] && [ -e "$SRC/NokiaMSN/public/media" ]; then
    set -- "$@" NokiaMSN/public/media
  fi
  rc=0
  tar -czf "$out" \
    --warning=no-file-changed --warning=no-file-removed --ignore-failed-read \
    --exclude='NokiaMSN/.wwebjs_auth/*/Default/Cache' \
    --exclude='NokiaMSN/.wwebjs_auth/*/Default/Code Cache' \
    --exclude='NokiaMSN/.wwebjs_auth/*/Default/Service Worker/CacheStorage' \
    --exclude='NokiaMSN/.wwebjs_auth/*/Default/GPUCache' \
    --exclude='NokiaMSN/.wwebjs_auth/*/Default/Dawn*Cache' \
    --exclude='NokiaMSN/.wwebjs_auth/*/Singleton*' \
    -C "$work" NokiaMSN/data/nokia.db \
    -C "$SRC" "$@" 2>"$work/err" || rc=$?
  if [ "$rc" -gt 1 ]; then
    fail "$start" "tar ($rc): $(tail -3 "$work/err")"; return 1
  fi
  if ! tar -tzf "$out" >/dev/null 2>&1; then
    fail "$start" "el fichero generado está dañado"; return 1
  fi

  # 3. Guardar con nombre definitivo; los domingos, además, como copia semanal.
  daily="$DEST/diaria-$stamp.tar.gz"
  mv "$out" "$daily"
  chmod 600 "$daily"; chown "$OWNER" "$daily" 2>/dev/null || true
  if [ "$(date +%u)" = "7" ]; then
    cp -p "$daily" "$DEST/semanal-$stamp.tar.gz"
  fi

  # 4. Rotación.
  ls -1 "$DEST"/diaria-*.tar.gz 2>/dev/null | sort -r | tail -n +"$((KEEP_DAILY + 1))" | xargs -r rm -f
  ls -1 "$DEST"/semanal-*.tar.gz 2>/dev/null | sort -r | tail -n +"$((KEEP_WEEKLY + 1))" | xargs -r rm -f

  bytes=$(stat -c %s "$daily")
  secs=$(( $(date +%s) - start ))
  write_status true "$(basename "$daily")" "$bytes" "$secs" ""
  log "copia hecha: $(basename "$daily") ($((bytes / 1024 / 1024)) MB, ${secs}s)"
  rm -rf "$work"
  trap - EXIT
}

fail() { # $1 = inicio, $2 = motivo
  write_status false "" 0 $(( $(date +%s) - $1 )) "$2"
  log "ERROR: $2"
  rm -rf "$work" "$out"
  trap - EXIT
}

last_backup_age() { # segundos desde la última copia correcta (muy grande si no hay)
  newest=$(ls -1 "$DEST"/diaria-*.tar.gz 2>/dev/null | sort -r | head -1)
  if [ -z "$newest" ]; then echo 999999999; return; fi
  echo $(( $(date +%s) - $(stat -c %Y "$newest") ))
}

case "${1:-daemon}" in
  now)
    run_backup
    ;;
  daemon)
    log "copias diarias a las $BACKUP_AT (${TZ:-UTC}); se guardan $KEEP_DAILY diarias y $KEEP_WEEKLY semanales en $DEST"
    # El healthcheck mira que /tmp/heartbeat sea reciente: se toca también mientras espera.
    touch /tmp/heartbeat
    # Al arrancar, si la última tiene más de un día, una copia tras dejar que todo arranque.
    if [ "$(last_backup_age)" -gt 86400 ]; then
      for _ in 1 2 3 4; do touch /tmp/heartbeat; sleep 30; done
      run_backup || true
    fi
    last_day=$(date +%F)
    [ "$(last_backup_age)" -lt 86400 ] || last_day=""
    while true; do
      touch /tmp/heartbeat
      if [ "$(date +%H:%M)" = "$BACKUP_AT" ] && [ "$(date +%F)" != "$last_day" ]; then
        run_backup || true
        last_day=$(date +%F)
      fi
      sleep 30
    done
    ;;
  *)
    echo "Uso: backup.sh daemon|now" >&2; exit 1
    ;;
esac
