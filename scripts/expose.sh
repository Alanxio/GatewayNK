#!/usr/bin/env bash
# Arranque y control del stack (Gateway, NokiaMSN, nokia-tls, Gallery, PlayME, DiscordProxy,
# ngrok y watchdog) con Docker Compose, y exposición a Internet:
#   · entrada HTTP en claro  → ngrok HTTP (contenedor «ngrok»)              → gateway:8080
#   · HTTPS del Nokia 6111   → playit.gg / ngrok TCP → nokia-tls:8443 → gateway:8080
# Todo queda en segundo plano y se recupera solo (ver docker-compose.yml y el watchdog);
# este script arranca, comprueba, y se queda mostrando los avisos hasta Ctrl+C.
# -E (errtrace): que el trap ERR también salte dentro de funciones, no solo a nivel superior.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/Gateway/.env"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
NGROK_DIR="$ROOT_DIR/.ngrok"
NGROK_CONFIG_FILE="$NGROK_DIR/ngrok.yml"
BUILD_STAMP_DIR="$ROOT_DIR/.state/build"
# HTTPS para el Nokia 6111 (servicio nokia-tls): la dirección pública del túnel TCP se
# guarda aquí para que nokia-tls genere su certificado y NokiaMSN la use en enlaces y SMS.
NOKIA_TLS_DIR="$ROOT_DIR/NokiaMSN/data/tls"
NOKIA_TLS_ADDRESS_FILE="$NOKIA_TLS_DIR/public-address"
NOKIA_TLS_NOTIFIED_FILE="$NOKIA_TLS_DIR/last-notified-address"

COMMAND="up"
REQUIRE_ALL=false
BUILD="auto"     # auto (solo lo que ha cambiado) | always | never
DETACH=false
TUNNELS_ARG=""   # http | https | both (por flag; si no, EXPOSE_TUNNELS del .env)
PHASE="startup"  # startup | attached (para el mensaje de Ctrl+C)
EXTRA_ARGS=()

usage() {
  cat <<EOF
Uso: $(basename "${BASH_SOURCE[0]}") [comando] [opciones]

Comandos:
  up (por defecto)   Arranca/actualiza todo, lo expone y se queda mostrando los avisos.
  status             Estado de cada servicio y de las entradas públicas.
  logs [servicio…]   Sigue los logs (todos o los indicados). Ctrl+C para salir.
  alerts             Sigue solo los avisos del watchdog (caídas, reinicios, túneles).
  top                Panel en la terminal que se actualiza solo (servicios, CPU, RAM, tráfico).
  backup             Hace una copia de seguridad ahora.
  restart servicio…  Reinicia los servicios indicados.
  stop               Para todo (contenedores y ngrok).

Opciones de «up»:
  --http        Solo la entrada HTTP (en claro).
  --https       Solo el HTTPS del Nokia (TLS 1.0, nokia-tls).
  --both        Las dos (por defecto). Sin flag: EXPOSE_TUNNELS del .env (http|https|both).
  --build       Reconstruye todas las imágenes.
  --no-build    No reconstruye nada. (Por defecto solo se reconstruye lo que ha cambiado.)
  --all         Si algún servicio no arranca bien, para con error.
  -d, --detach  No se queda mostrando avisos al terminar de arrancar.

El HTTPS del Nokia lo lleva NOKIA_TLS_PROVIDER (playit | ngrok) de Gateway/.env.
Ctrl+C solo cierra esta terminal: los servicios, ngrok y el watchdog siguen funcionando.
EOF
}

if [ $# -gt 0 ]; then
  case "$1" in
    up|status|logs|alerts|top|backup|restart|stop) COMMAND="$1"; shift ;;
  esac
fi
for arg in "$@"; do
  case "$arg" in
    --all)        REQUIRE_ALL=true ;;
    --build)      BUILD="always" ;;
    --no-build)   BUILD="never" ;;
    -d|--detach)  DETACH=true ;;
    --http)       TUNNELS_ARG="http" ;;
    --https)      TUNNELS_ARG="https" ;;
    --both)       TUNNELS_ARG="both" ;;
    -h|--help)    usage; exit 0 ;;
    -*) echo "Opción desconocida: $arg" >&2; usage >&2; exit 1 ;;
    *)
      if [ "$COMMAND" = "logs" ] || [ "$COMMAND" = "restart" ]; then
        EXTRA_ARGS+=("$arg")
      else
        echo "Argumento inesperado: $arg" >&2; usage >&2; exit 1
      fi
      ;;
  esac
done

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

GATEWAY_PORT="${GATEWAY_PORT:-8080}"
NOKIA_MSN_PORT="${NOKIA_MSN_PORT:-3001}"
NOKIA_TLS_PORT="${NOKIA_TLS_PORT:-8443}"
# API local del agente ngrok (contenedor «ngrok», publicada solo en 127.0.0.1).
NGROK_API_PORT="${NGROK_API_PORT:-4045}"
STATUS_PORT="${STATUS_PORT:-8090}"
STATUS_URL="http://127.0.0.1:${STATUS_PORT}"
BACKUP_DIR="${BACKUP_DIR:-/home/alanxio/Backups/GateWayNK}"
NGROK_START_TIMEOUT="${NGROK_START_TIMEOUT:-40}"
NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN:-}"
NGROK_HTTP_URL="${NGROK_HTTP_URL:-}"
export NGROK_API_PORT

# ── Qué se expone y quién lo lleva ─────────────────────────────────────────
# Entradas pedidas: flag > EXPOSE_TUNNELS del .env > both (o http si NOKIA_TLS_ENABLED=false).
if [ -z "$TUNNELS_ARG" ]; then
  if [ -n "${EXPOSE_TUNNELS:-}" ]; then
    TUNNELS_ARG="$EXPOSE_TUNNELS"
  elif [ "${NOKIA_TLS_ENABLED:-true}" = "true" ]; then
    TUNNELS_ARG="both"
  else
    TUNNELS_ARG="http"
  fi
fi
case "$TUNNELS_ARG" in
  http)  HTTP_ENABLED=true;  TLS_ENABLED=false ;;
  https) HTTP_ENABLED=false; TLS_ENABLED=true ;;
  both)  HTTP_ENABLED=true;  TLS_ENABLED=true ;;
  *) echo "EXPOSE_TUNNELS / flag no válido: '$TUNNELS_ARG' (usa http, https o both)" >&2; exit 1 ;;
esac

# HTTPS del Nokia:
#   ngrok  → túnel TCP de ngrok (gratis, la dirección cambia en cada reinicio de ngrok →
#            el watchdog actualiza nokia-tls y avisa por SMS)
#   playit → túnel TCP fijo de playit.gg (servicio del sistema, siempre activo),
#            dirección en NOKIA_TLS_PUBLIC_ADDRESS («host:puerto»)
NOKIA_TLS_PROVIDER="${NOKIA_TLS_PROVIDER:-ngrok}"
NOKIA_TLS_PUBLIC_ADDRESS="${NOKIA_TLS_PUBLIC_ADDRESS:-}"
case "$NOKIA_TLS_PROVIDER" in
  ngrok|playit) ;;
  *) echo "NOKIA_TLS_PROVIDER no válido: '$NOKIA_TLS_PROVIDER' (usa ngrok o playit)" >&2; exit 1 ;;
esac
is_host_port() { printf '%s' "$1" | grep -qE '^[A-Za-z0-9.-]+:[0-9]{1,5}$'; }
if [ "$COMMAND" = "up" ] && [ "$NOKIA_TLS_PROVIDER" = "playit" ] && [ "$TLS_ENABLED" = "true" ] \
   && ! is_host_port "$NOKIA_TLS_PUBLIC_ADDRESS"; then
  echo "Con NOKIA_TLS_PROVIDER=playit hace falta NOKIA_TLS_PUBLIC_ADDRESS=host:puerto en Gateway/.env" >&2
  exit 1
fi

NGROK_HTTP="$HTTP_ENABLED"
NGROK_TLS=false
if [ "$TLS_ENABLED" = "true" ] && [ "$NOKIA_TLS_PROVIDER" = "ngrok" ]; then NGROK_TLS=true; fi

# ── Salida ─────────────────────────────────────────────────────────────────
# Colores solo si la salida es una terminal real (no al redirigir a un log).
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
  CLEAR_LINE=$'\r\033[K'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; CLEAR_LINE=''
fi

log_step() { printf '\n%s%s▶ %s%s\n' "$C_BOLD" "$C_CYAN" "$1" "$C_RESET"; }
log_ok()   { printf '  %s✔%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
log_warn() { printf '  %s⚠%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
log_err()  { printf '  %s✘%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; }
log_info() { printf '  %s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }

fail() {
  log_err "$1"
  exit 1
}

# ── Señales ────────────────────────────────────────────────────────────────
INTERRUPTED=false
# Red de seguridad: si un comando falla de forma inesperada (no protegido con || o un if),
# se ve en qué línea, qué comando y con qué código. No salta al pulsar Ctrl+C.
on_error() {
  local exit_code=$? line_no=$1
  [ "$INTERRUPTED" = true ] && return 0
  log_err "Fallo inesperado en la línea ${line_no} (código ${exit_code}): ${BASH_COMMAND}"
  log_info "Revisa los logs con: $(basename "$0") logs"
}
trap 'on_error $LINENO' ERR

on_interrupt() {
  INTERRUPTED=true
  printf '%s\n' "$CLEAR_LINE"
  if [ "$PHASE" = "attached" ]; then
    log_info "Saliendo. Todo sigue funcionando en segundo plano ($(basename "$0") status / alerts / stop)."
    exit 0
  fi
  log_warn "Interrumpido. Lo que ya estaba arrancado sigue en marcha ($(basename "$0") stop para pararlo)."
  exit 130
}
trap on_interrupt INT TERM

cd "$ROOT_DIR"

# ── Docker Compose ─────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || fail "docker no está disponible en el PATH."
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose -f "$COMPOSE_FILE"); DC_NAME="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose -f "$COMPOSE_FILE"); DC_NAME="docker-compose"
else
  fail "docker compose no está disponible."
fi
DC_ALL=("${DC[@]}" --profile ngrok)   # incluye ngrok (para status/logs/stop)

container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }

# Últimas líneas de log de un servicio, sangradas, para enseñarlas junto a un error.
show_logs() { # $1 = servicio, $2 = líneas
  "${DC_ALL[@]}" logs --no-color --no-log-prefix --tail "${2:-25}" "$1" 2>&1 \
    | sed "s/^/    ${C_DIM}│${C_RESET} /" || true
}

# ── Avisos del watchdog ────────────────────────────────────────────────────
notify_desktop() {
  if command -v notify-send >/dev/null 2>&1 && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
    notify-send -u "$1" -a GateWayNK "GateWayNK" "$2" >/dev/null 2>&1 || true
  fi
}

format_alert_line() {
  local line="$1"
  if [[ "$line" =~ ^([0-9:]+)\ (ALERTA|OK|INFO)\ (.*)$ ]]; then
    local ts="${BASH_REMATCH[1]}" level="${BASH_REMATCH[2]}" msg="${BASH_REMATCH[3]}"
    case "$level" in
      ALERTA) printf '%s%s%s %s✘ %s%s\n' "$C_DIM" "$ts" "$C_RESET" "$C_RED$C_BOLD" "$msg" "$C_RESET"
              notify_desktop critical "$msg" ;;
      OK)     printf '%s%s%s %s✔ %s%s\n' "$C_DIM" "$ts" "$C_RESET" "$C_GREEN" "$msg" "$C_RESET"
              notify_desktop normal "$msg" ;;
      *)      printf '%s%s%s %s%s%s\n' "$C_DIM" "$ts" "$C_RESET" "$C_DIM" "$msg" "$C_RESET" ;;
    esac
  elif [[ "$line" == "    │"* ]]; then
    printf '%s%s%s\n' "$C_DIM" "$line" "$C_RESET"
  else
    printf '%s\n' "$line"
  fi
}

# Sigue los avisos del watchdog; si el watchdog se reinicia, vuelve a engancharse.
follow_alerts() { # $1 = líneas antiguas a mostrar al empezar
  local tail_lines="${1:-0}" since=""
  PHASE="attached"
  log_info "Mostrando avisos del watchdog (caídas, bloqueos, túneles). Ctrl+C para salir: todo sigue funcionando."
  while true; do
    if container_running watchdog; then
      local args=(logs -f)
      if [ -n "$since" ]; then args+=(--since "$since"); else args+=(--tail "$tail_lines"); fi
      docker "${args[@]}" watchdog 2>&1 | while IFS= read -r line; do format_alert_line "$line"; done || true
      since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    else
      log_warn "El watchdog no está en marcha; reintentando…"
    fi
    sleep 3
  done
}

# ── ngrok ──────────────────────────────────────────────────────────────────
ngrok_tunnel_url() { # $1 = http | tcp
  curl -fsS -m 3 "http://127.0.0.1:${NGROK_API_PORT}/api/tunnels" 2>/dev/null | python3 -c '
import json, sys
kind = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
urls = [t.get("public_url", "") for t in data.get("tunnels", [])]
if kind == "tcp":
    urls = [u for u in urls if u.startswith("tcp://")]
else:
    # Con schemes http+https hay dos URLs para el mismo túnel: la http:// es la del Nokia.
    urls = sorted((u for u in urls if u.startswith(("http://", "https://"))),
                  key=lambda u: 0 if u.startswith("http://") else 1)
if urls:
    print(urls[0])
' "$1" 2>/dev/null || true
}

# ── Subcomandos simples ────────────────────────────────────────────────────
cmd_status() {
  printf '%sServicios%s\n' "$C_BOLD" "$C_RESET"
  "${DC_ALL[@]}" ps -a --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null || true
  printf '\n%sEntradas públicas%s\n' "$C_BOLD" "$C_RESET"
  local http_url tcp_url
  if container_running ngrok; then
    http_url="$(ngrok_tunnel_url http)"; tcp_url="$(ngrok_tunnel_url tcp)"
    printf '  %-13s %s\n' "HTTP:" "${http_url:-(ngrok sin túnel HTTP)}"
    if [ -n "$tcp_url" ]; then printf '  %-13s %s\n' "ngrok TCP:" "$tcp_url"; fi
  else
    printf '  %-13s %s\n' "HTTP:" "(ngrok parado)"
  fi
  if [ -f "$NOKIA_TLS_ADDRESS_FILE" ]; then
    printf '  %-13s https://%s/  (%s)\n' "Nokia HTTPS:" "$(cat "$NOKIA_TLS_ADDRESS_FILE")" "$NOKIA_TLS_PROVIDER"
  fi
  if [ "$NOKIA_TLS_PROVIDER" = "playit" ]; then
    printf '  %-13s %s\n' "playit:" "$(systemctl is-active playit 2>/dev/null || echo desconocido)"
  fi
}

# Panel en la terminal: lee el estado del watchdog cada 2 s y lo pinta (scripts/top.py).
cmd_top() {
  container_running watchdog || fail "El watchdog no está en marcha (expose.sh up)."
  local color=0 frame
  [ -t 1 ] && color=1
  while true; do
    frame="$(curl -fsS -m 3 "$STATUS_URL/api/status" 2>/dev/null | python3 "$ROOT_DIR/scripts/top.py" "$color" || true)"
    printf '\033[H\033[2J%s\n' "$frame"
    sleep 2
  done
}

case "$COMMAND" in
  status)  cmd_status; exit 0 ;;
  logs)    PHASE="attached"; "${DC_ALL[@]}" logs -f --tail 100 "${EXTRA_ARGS[@]}"; exit 0 ;;
  alerts)  follow_alerts 50 ;;
  top)     PHASE="attached"; cmd_top ;;
  backup)
    container_running backup || fail "El servicio de copias no está en marcha (expose.sh up)."
    log_step "Copia de seguridad"
    if docker exec backup backup.sh now; then
      log_ok "Copia guardada en $BACKUP_DIR"
    else
      fail "La copia ha fallado (el motivo está justo encima)."
    fi
    exit 0 ;;
  restart)
    [ "${#EXTRA_ARGS[@]}" -gt 0 ] || fail "Indica qué servicios reiniciar (p. ej.: restart nokia-msn)."
    "${DC_ALL[@]}" restart "${EXTRA_ARGS[@]}"; exit 0 ;;
  stop)
    log_step "Parando todo"
    "${DC_ALL[@]}" down
    # Una dirección TCP de ngrok deja de existir al pararlo; la de playit es fija.
    if [ "$NOKIA_TLS_PROVIDER" = "ngrok" ]; then rm -f "$NOKIA_TLS_ADDRESS_FILE"; fi
    log_ok "Parado."
    exit 0 ;;
esac

# ════════════════════════════════════════════════════════════════════════════
# up
# ════════════════════════════════════════════════════════════════════════════
log_step "Comprobando requisitos"
log_ok "docker y ${DC_NAME} disponibles"
command -v python3 >/dev/null 2>&1 || fail "Falta python3 (se usa para leer la configuración y la API de ngrok)."
# Creadas como este usuario (si las creara Docker, serían de root).
mkdir -p "$NGROK_DIR" "$BUILD_STAMP_DIR" "$ROOT_DIR/.state/watchdog" "$BACKUP_DIR"

if [ "$NGROK_HTTP" = "true" ] || [ "$NGROK_TLS" = "true" ]; then
  if [ -z "$NGROK_AUTHTOKEN" ]; then
    log_warn "Sin ngrok: falta NGROK_AUTHTOKEN en Gateway/.env."
    NGROK_HTTP=false; NGROK_TLS=false
  else
    log_ok "ngrok: contenedor ngrok/ngrok"
  fi
fi
NGROK_NEEDED=false
if [ "$NGROK_HTTP" = "true" ] || [ "$NGROK_TLS" = "true" ]; then NGROK_NEEDED=true; fi

# Un ngrok del sistema (snap) con la misma cuenta gratuita ocuparía la única sesión.
if [ "$NGROK_NEEDED" = "true" ]; then
  host_ngrok="$(pgrep -x ngrok 2>/dev/null || true)"
  if [ -n "$host_ngrok" ] && container_running ngrok; then
    container_pids="$(docker top ngrok -eo pid 2>/dev/null | tail -n +2 | tr -d ' ' || true)"
    host_ngrok="$(printf '%s\n' "$host_ngrok" | grep -vxF -f <(printf '%s\n' "$container_pids") || true)"
  fi
  if [ -n "$host_ngrok" ]; then
    log_warn "Hay otro ngrok fuera de Docker (PIDs: $(printf '%s' "$host_ngrok" | tr '\n' ' ')). La cuenta gratuita solo admite una sesión: páralo o el contenedor no conectará."
  fi
fi

# Configuración de ngrok (sin secretos: el authtoken va por variable de entorno).
write_ngrok_config() { # $1 = túnel HTTP, $2 = túnel TCP del Nokia; escribe en $3
  {
    echo 'version: "2"'
    echo 'web_addr: 0.0.0.0:4040'
    echo 'tunnels:'
    if [ "$1" = "true" ]; then
      echo '  gateway:'
      echo '    proto: http'
      echo '    addr: gateway:8080'
      if [ -n "$NGROK_HTTP_URL" ]; then
        echo "    domain: $(printf '%s' "$NGROK_HTTP_URL" | sed -E 's#^[a-z]+://##; s#/.*$##')"
      fi
      # Sin esto ngrok solo abre https:// (certificado moderno que el 6111 no acepta).
      echo '    schemes:'
      echo '      - http'
      echo '      - https'
    fi
    if [ "$2" = "true" ]; then
      # Sin proxy_proto: la cuenta gratuita «legacy» no lo permite (ERR_NGROK_9014) y
      # ngrok tumba la sesión ENTERA, también el túnel HTTP.
      echo '  nokia-tls:'
      echo '    proto: tcp'
      echo '    addr: nokia-tls:8443'
    fi
  } > "$3"
}
NGROK_CONFIG_CHANGED=false
if [ "$NGROK_NEEDED" = "true" ]; then
  new_config="$(mktemp "$NGROK_DIR/.ngrok.XXXXXX.yml")"
  write_ngrok_config "$NGROK_HTTP" "$NGROK_TLS" "$new_config"
  if ! cmp -s "$new_config" "$NGROK_CONFIG_FILE"; then NGROK_CONFIG_CHANGED=true; fi
  mv "$new_config" "$NGROK_CONFIG_FILE"
  chmod 644 "$NGROK_CONFIG_FILE"
fi

# ── Construcción: solo de lo que ha cambiado ───────────────────────────────
# Cada servicio con «build» tiene un sello en .state/build/<servicio>. Si algún fichero de su
# contexto es más nuevo que el sello, se reconstruye; si no, se usa la imagen que ya hay.
build_contexts() {
  "${DC[@]}" config --format json 2>/dev/null | python3 -c '
import json, sys
for name, svc in json.load(sys.stdin)["services"].items():
    if svc.get("build"):
        print(name + "\t" + svc["build"]["context"])
'
}

context_changed() { # $1 = contexto, $2 = sello
  [ -f "$2" ] || return 0
  [ -n "$(find "$1" -mindepth 1 \( -name node_modules -o -name .git -o -name data -o -name .wwebjs_auth \
      -o -name .wwebjs_cache -o -name .puppeteer_cache -o -name media -o -name data-tls-probe \) -prune \
      -o -type f -newer "$2" -print -quit 2>/dev/null)" ]
}

TO_BUILD=()
if [ "$BUILD" != "never" ]; then
  while IFS=$'\t' read -r svc ctx; do
    [ -n "$svc" ] || continue
    if [ "$BUILD" = "always" ] || context_changed "$ctx" "$BUILD_STAMP_DIR/$svc"; then
      TO_BUILD+=("$svc")
    fi
  done < <(build_contexts)
fi

if [ "${#TO_BUILD[@]}" -gt 0 ]; then
  log_step "Construyendo imágenes: ${TO_BUILD[*]}"
  build_started="$(date +%s)"
  if ! "${DC[@]}" build "${TO_BUILD[@]}"; then
    log_err "Ha fallado la construcción (el error de Docker está justo encima)."
    exit 1
  fi
  for svc in "${TO_BUILD[@]}"; do touch -d "@$build_started" "$BUILD_STAMP_DIR/$svc"; done
  log_ok "Imágenes construidas"
else
  log_info "Imágenes al día: no hace falta construir nada."
fi

# ── Arranque ───────────────────────────────────────────────────────────────
log_step "Arrancando servicios"
UP_ARGS=(up -d --remove-orphans)
PROFILE_ARGS=()
# El .env de la raíz activa el perfil ngrok (para que «docker compose down» a mano lo
# incluya); aquí se decide de verdad: la variable de entorno tiene prioridad sobre el .env.
export COMPOSE_PROFILES=""
if [ "$NGROK_NEEDED" = "true" ]; then
  PROFILE_ARGS=(--profile ngrok)
  NGROK_WAS_RUNNING=false
  container_running ngrok && NGROK_WAS_RUNNING=true
fi
if ! "${DC[@]}" "${PROFILE_ARGS[@]}" "${UP_ARGS[@]}"; then
  log_err "docker compose up ha fallado (el error de Docker está justo encima)."
  exit 1
fi
if [ "$NGROK_NEEDED" = "true" ]; then
  if [ "$NGROK_WAS_RUNNING" = "true" ] && [ "$NGROK_CONFIG_CHANGED" = "true" ]; then
    log_info "La configuración de ngrok ha cambiado: reiniciándolo."
    docker restart ngrok >/dev/null
  fi
elif docker inspect ngrok >/dev/null 2>&1; then
  log_info "ngrok no hace falta con esta configuración: parándolo."
  "${DC_ALL[@]}" rm -sf ngrok >/dev/null 2>&1 || true
fi
log_ok "Contenedores en marcha"

# ── Espera a que estén sanos (todos a la vez) ──────────────────────────────
# Fuente de verdad: el healthcheck de cada contenedor. Si uno se cae o se reinicia mientras
# arranca, se marca como fallido al momento (sin esperar al timeout) y se enseñan sus logs.
service_timeout() {
  case "$1" in
    gallery|playme) echo 300 ;;
    nokia-msn)      echo 180 ;;
    *)              echo 90 ;;
  esac
}

log_step "Esperando a que los servicios estén sanos"
mapfile -t WAIT_SERVICES < <("${DC[@]}" "${PROFILE_ARGS[@]}" ps --format '{{.Service}}' 2>/dev/null | sort)
declare -A INITIAL_RESTARTS=()
FAILED_SERVICES=()
READY_SERVICES=()
PENDING=("${WAIT_SERVICES[@]}")
WAIT_START="$(date +%s)"

inspect_service() { # → "estado salud reinicios"
  docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$1" 2>/dev/null \
    || echo "missing none 0"
}
for svc in "${WAIT_SERVICES[@]}"; do
  read -r _ _ restarts <<<"$(inspect_service "$svc")"
  INITIAL_RESTARTS[$svc]="$restarts"
done

service_failed() { # $1 = servicio, $2 = motivo
  printf '%s' "$CLEAR_LINE"
  log_err "$1: $2. Últimos logs:"
  show_logs "$1" 25
  FAILED_SERVICES+=("$1")
}

while [ "${#PENDING[@]}" -gt 0 ]; do
  elapsed=$(( $(date +%s) - WAIT_START ))
  still=()
  for svc in "${PENDING[@]}"; do
    read -r state health restarts <<<"$(inspect_service "$svc")"
    if [ "$state" = "running" ] && { [ "$health" = "healthy" ] || [ "$health" = "none" ]; }; then
      printf '%s' "$CLEAR_LINE"
      log_ok "$(printf '%-16s listo (%ss)' "$svc" "$elapsed")"
      READY_SERVICES+=("$svc")
    elif [ "$state" = "exited" ] || [ "$state" = "dead" ] || [ "$state" = "missing" ]; then
      service_failed "$svc" "se ha parado al arrancar (estado: $state)"
    elif [ "$state" = "restarting" ] || [ "$restarts" -gt "${INITIAL_RESTARTS[$svc]:-0}" ]; then
      service_failed "$svc" "se ha caído al arrancar y Docker lo está reiniciando"
    elif [ "$health" = "unhealthy" ]; then
      service_failed "$svc" "no pasa su healthcheck"
    elif [ "$elapsed" -ge "$(service_timeout "$svc")" ]; then
      service_failed "$svc" "sigue sin estar listo tras ${elapsed}s"
    else
      still+=("$svc")
    fi
  done
  PENDING=("${still[@]}")
  if [ "${#PENDING[@]}" -gt 0 ]; then
    printf '%s  %s… esperando %s (%ss)%s' "$CLEAR_LINE" "$C_YELLOW" "${PENDING[*]}" "$elapsed" "$C_RESET"
    sleep 1
  fi
done
printf '%s' "$CLEAR_LINE"

if [ "${#FAILED_SERVICES[@]}" -gt 0 ]; then
  if [ "$REQUIRE_ALL" = true ]; then
    log_err "Con problemas: ${FAILED_SERVICES[*]} (--all: se para aquí)."
    log_info "Logs completos: $(basename "$0") logs ${FAILED_SERVICES[*]}"
    exit 1
  fi
  log_warn "Con problemas: ${FAILED_SERVICES[*]} — el resto sigue. El watchdog los irá reiniciando y avisará."
  log_info "Logs completos: $(basename "$0") logs ${FAILED_SERVICES[*]}"
fi

# Extra informativo: estado real del puente de WhatsApp (no bloquea el arranque).
WA_STATUS="$(curl -sS -m 3 "http://127.0.0.1:${NOKIA_MSN_PORT}/healthz" 2>/dev/null \
  | grep -oE '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
if [ -n "${WA_STATUS:-}" ]; then
  case "$WA_STATUS" in
    connected) log_info "Estado de WhatsApp: ${C_GREEN}${WA_STATUS}${C_RESET}" ;;
    *)         log_info "Estado de WhatsApp: ${C_YELLOW}${WA_STATUS}${C_RESET} (escanea el QR en /whatsapp/qr si hace falta)" ;;
  esac
fi

# ── HTTPS del Nokia ────────────────────────────────────────────────────────
# Prueba la conexión cifrada como la haría el 6111 (TLS 1.0 + AES, sin SNI), verificando
# contra la raíz instalada en el Nokia y el nombre del certificado.
probe_nokia_tls() {
  local tls_address="$1" host="${1%:*}" probe
  # /health lo responde el Gateway sin pasar por NokiaMSN: prueba la cadena completa
  # (playit → nokia-tls → Gateway) sin dejar un «Acceso denegado» en el log de seguridad.
  probe="$(printf 'GET /health HTTP/1.0\r\n\r\n' | timeout 15 openssl s_client -connect "$tls_address" -tls1 \
    -cipher 'AES256-SHA:AES128-SHA:@SECLEVEL=0' -noservername -CAfile "$NOKIA_TLS_DIR/ca.pem" \
    -verify_hostname "$host" -ign_eof 2>&1 || true)"
  if printf '%s' "$probe" | grep -q 'Verify return code: 0' && printf '%s' "$probe" | grep -q '"status":"ok"'; then
    log_ok "HTTPS del Nokia comprobado desde Internet: https://${tls_address}/ ($(printf '%s' "$probe" | grep -m1 -oE 'Cipher +: [A-Z0-9-]+' | sed -E 's/Cipher +: //' || true))"
    return 0
  fi
  return 1
}

wait_healthy() { # $1 = contenedor, $2 = segundos
  local i health
  for (( i = 0; i < $2; i++ )); do
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1" 2>/dev/null || true)"
    [ "$health" = "healthy" ] && return 0
    sleep 1
  done
  return 1
}

# Guarda la dirección pública y reinicia nokia-tls solo si ha cambiado (genera entonces el
# certificado de esa dirección, firmado por la raíz ya instalada en el Nokia). Reiniciar sin
# necesidad cortaría las conexiones abiertas del teléfono.
apply_nokia_tls_address() {
  local tls_address="$1" previous
  if [ ! -f "$NOKIA_TLS_DIR/ca.pem" ] || [ ! -f "$NOKIA_TLS_DIR/ca.key" ]; then
    log_warn "Falta la raíz del Nokia en $NOKIA_TLS_DIR (ca.pem / ca.key): no se activa el HTTPS."
    rm -f "$NOKIA_TLS_ADDRESS_FILE"
    return 1
  fi
  previous="$(cat "$NOKIA_TLS_ADDRESS_FILE" 2>/dev/null || true)"
  echo "$tls_address" > "$NOKIA_TLS_ADDRESS_FILE"
  if [ "$previous" = "$tls_address" ] && [ -f "$NOKIA_TLS_DIR/server-${tls_address%:*}.pem" ] \
     && container_running nokia-tls; then
    log_info "nokia-tls ya usa ${tls_address}; no hace falta reiniciarlo."
    return 0
  fi
  if ! docker restart nokia-tls >/dev/null 2>&1; then
    log_warn "No se pudo reiniciar nokia-tls; el certificado puede no coincidir con ${tls_address}."
    return 1
  fi
  wait_healthy nokia-tls 30 || log_warn "nokia-tls tarda en volver tras el reinicio."
  log_info "nokia-tls reiniciado con la dirección ${tls_address}."
}

# SMS con la dirección HTTPS, solo si ha cambiado desde el último aviso (ngrok).
notify_nokia_tls_address() {
  local tls_address="$1" previous sms_text sms_result
  previous="$(cat "$NOKIA_TLS_NOTIFIED_FILE" 2>/dev/null || true)"
  if [ "$previous" = "$tls_address" ]; then
    log_info "La dirección HTTPS no ha cambiado; no se manda SMS."
    return 0
  fi
  sms_text="NokiaMSN: nueva direccion segura https://${tls_address}/ . Actualiza el marcador del Nokia."
  sms_result="$(docker exec nokia-msn node -e "
const p = require('path').resolve('src/services/sms-notification.service.js');
import(p).then((m) => m.sendSecurityAlertSms(process.argv[1]))
  .then((r) => console.log(r && r.status))
  .catch((e) => console.log('error: ' + e.message));
" "$sms_text" 2>/dev/null | tail -1 || true)"
  if [ "$sms_result" = "sent" ]; then
    echo "$tls_address" > "$NOKIA_TLS_NOTIFIED_FILE"
    log_ok "SMS enviado con la nueva dirección HTTPS."
  else
    log_warn "No se pudo enviar el SMS con la nueva dirección (${sms_result:-sin respuesta})."
  fi
}

if [ "$TLS_ENABLED" = "true" ] && [ "$NOKIA_TLS_PROVIDER" = "playit" ]; then
  log_step "HTTPS del Nokia (playit.gg)"
  if ! systemctl is-active --quiet playit 2>/dev/null; then
    log_warn "El servicio playit no está activo (sudo systemctl enable --now playit). El HTTPS del Nokia no funcionará hasta que lo esté."
  fi
  if apply_nokia_tls_address "$NOKIA_TLS_PUBLIC_ADDRESS" && ! probe_nokia_tls "$NOKIA_TLS_PUBLIC_ADDRESS"; then
    log_warn "No se pudo comprobar https://${NOKIA_TLS_PUBLIC_ADDRESS}/ desde aquí (¿túnel de playit apagado o mal configurado?)."
    log_info "Revisa en playit.gg que el túnel apunte a 127.0.0.1:${NOKIA_TLS_PORT} y que el agente esté en línea."
  fi
elif [ "$NOKIA_TLS_PROVIDER" = "ngrok" ] && [ "$NGROK_TLS" != "true" ]; then
  rm -f "$NOKIA_TLS_ADDRESS_FILE"
fi

# ── ngrok ──────────────────────────────────────────────────────────────────
NGROK_HTTP_PUBLIC=""
NGROK_TCP_PUBLIC=""

# Espera a que la API de ngrok publique los túneles pedidos. Devuelve 1 si el contenedor
# se cae/reinicia (p. ej. un túnel rechazado por la cuenta) o se agota el tiempo.
wait_ngrok_tunnels() { # $1 = HTTP, $2 = TCP
  local deadline restarts0 state restarts
  read -r _ _ restarts0 <<<"$(inspect_service ngrok)"
  deadline=$(( $(date +%s) + NGROK_START_TIMEOUT ))
  NGROK_HTTP_PUBLIC=""; NGROK_TCP_PUBLIC=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    read -r state _ restarts <<<"$(inspect_service ngrok)"
    if [ "$state" != "running" ] || [ "$restarts" -gt "$restarts0" ]; then return 1; fi
    if [ "$1" = "true" ] && [ -z "$NGROK_HTTP_PUBLIC" ]; then NGROK_HTTP_PUBLIC="$(ngrok_tunnel_url http)"; fi
    if [ "$2" = "true" ] && [ -z "$NGROK_TCP_PUBLIC" ]; then NGROK_TCP_PUBLIC="$(ngrok_tunnel_url tcp)"; fi
    if { [ "$1" != "true" ] || [ -n "$NGROK_HTTP_PUBLIC" ]; } && { [ "$2" != "true" ] || [ -n "$NGROK_TCP_PUBLIC" ]; }; then
      return 0
    fi
    sleep 1
  done
  return 1
}

ngrok_error() { # primer error que haya escrito ngrok, legible
  docker logs --tail 50 ngrok 2>&1 | grep -oE 'ERROR: +[^ ].*|err="[^"]*"' | head -1 \
    | sed -E 's/^ERROR: +//; s/^err="//; s/"$//' || true
}

if [ "$NGROK_NEEDED" = "true" ]; then
  log_step "Exposición pública (ngrok)"
  case "$NGROK_HTTP/$NGROK_TLS" in
    true/true)  log_info "Túneles: HTTP + HTTPS del Nokia" ;;
    true/false) log_info "Túneles: solo HTTP" ;;
    false/true) log_info "Túneles: solo HTTPS del Nokia" ;;
  esac
  if ! wait_ngrok_tunnels "$NGROK_HTTP" "$NGROK_TLS"; then
    if [ "$NGROK_HTTP" = "true" ] && [ "$NGROK_TLS" = "true" ] && [ -z "$NGROK_TCP_PUBLIC" ]; then
      # Con los dos pedidos, que el túnel TCP nunca deje sin acceso: seguir solo con HTTP.
      # (Con --https NO se cae a HTTP: sería abrir en claro algo no pedido.)
      log_warn "ngrok no abrió el túnel HTTPS del Nokia: $(ngrok_error)"
      log_info "Siguiendo solo con el túnel HTTP…"
      NGROK_TLS=false
      write_ngrok_config true false "$NGROK_CONFIG_FILE"
      docker restart ngrok >/dev/null
      wait_ngrok_tunnels true false || true
    fi
  fi

  if [ "$NGROK_TLS" = "true" ]; then
    if [ -n "$NGROK_TCP_PUBLIC" ] && is_host_port "${NGROK_TCP_PUBLIC#tcp://}"; then
      tls_address="${NGROK_TCP_PUBLIC#tcp://}"
      if apply_nokia_tls_address "$tls_address"; then
        probe_nokia_tls "$tls_address" || log_warn "No se pudo comprobar https://${tls_address}/ desde aquí; se deja activo igualmente."
        notify_nokia_tls_address "$tls_address"
      fi
    else
      log_warn "No apareció el túnel TCP del Nokia: $(ngrok_error)"
      rm -f "$NOKIA_TLS_ADDRESS_FILE"
    fi
  fi
  if [ "$NGROK_HTTP" = "true" ]; then
    if [ -n "$NGROK_HTTP_PUBLIC" ]; then
      log_ok "Túnel HTTP activo: $NGROK_HTTP_PUBLIC"
    else
      log_err "ngrok no ha abierto el túnel HTTP: $(ngrok_error). Últimos logs:"
      show_logs ngrok 15
    fi
  fi
fi

# ── Resumen ────────────────────────────────────────────────────────────────
print_summary() {
  local width=58 svc
  printf '\n%s' "$C_BOLD"
  printf '═%.0s' $(seq 1 "$width"); printf '\n  Resumen\n'
  printf '═%.0s' $(seq 1 "$width"); printf '%s\n' "$C_RESET"
  for svc in "${FAILED_SERVICES[@]}"; do
    printf '  %s✘ %s con problemas%s\n' "$C_RED" "$svc" "$C_RESET"
  done
  printf '  %-13s %s\n' "Local:" "http://localhost:${GATEWAY_PORT}/  (/gallery, /playme, /discord)"
  if [ -n "$NGROK_HTTP_PUBLIC" ]; then printf '  %-13s %s\n' "HTTP:" "$NGROK_HTTP_PUBLIC"; fi
  if [ -f "$NOKIA_TLS_ADDRESS_FILE" ]; then
    printf '  %-13s %s  %s(%s)%s\n' "Nokia HTTPS:" "https://$(cat "$NOKIA_TLS_ADDRESS_FILE")/" "$C_DIM" "$NOKIA_TLS_PROVIDER" "$C_RESET"
  fi
  if [ -z "$NGROK_HTTP_PUBLIC" ] && [ ! -f "$NOKIA_TLS_ADDRESS_FILE" ]; then
    printf '  %s(sin entrada pública: solo acceso local)%s\n' "$C_YELLOW" "$C_RESET"
  fi
  printf '  %-13s %s\n' "Servicios:" "${#READY_SERVICES[@]}/${#WAIT_SERVICES[@]} sanos · recuperación automática: watchdog"
  printf '  %-13s %s  %s(o: expose.sh top)%s\n' "Estado:" "$STATUS_URL" "$C_DIM" "$C_RESET"
  printf '%s' "$C_BOLD"; printf '═%.0s' $(seq 1 "$width"); printf '%s\n' "$C_RESET"
}
print_summary

if [ "$HTTP_ENABLED" = "true" ] && [ -z "$NGROK_HTTP_PUBLIC" ] && [ ! -f "$NOKIA_TLS_ADDRESS_FILE" ]; then
  log_err "No hay ninguna entrada pública activa."
  exit 1
fi
if [ "$TLS_ENABLED" = "true" ] && [ "$HTTP_ENABLED" != "true" ] && [ ! -f "$NOKIA_TLS_ADDRESS_FILE" ]; then
  log_err "Solo se pidió HTTPS y el túnel del Nokia no está activo: no hay acceso público."
  exit 1
fi

if [ "$DETACH" = true ]; then
  log_info "Todo en segundo plano. $(basename "$0") status / alerts / logs / stop"
  exit 0
fi
printf '\n'
follow_alerts 0
