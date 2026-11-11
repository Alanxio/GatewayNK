#!/usr/bin/env python3
"""Panel de «expose.sh top»: lee el JSON de estado del watchdog por stdin y lo pinta.

Uso: curl -s http://127.0.0.1:8090/api/status | python3 top.py [color: 1|0]
"""
import json
import sys
import time

COLOR = len(sys.argv) > 1 and sys.argv[1] == "1"


def c(code, text):
    return f"\033[{code}m{text}\033[0m" if COLOR else str(text)


def dur(ms):
    s = int(ms / 1000)
    if s < 90:
        return f"{s}s"
    if s < 5400:
        return f"{s // 60}min"
    if s < 172800:
        return f"{s // 3600}h"
    return f"{s // 86400}d"


def size(n):
    if n is None:
        return "—"
    return f"{n / 1024 ** 3:.1f}G" if n >= 1024 ** 3 else f"{n / 1024 ** 2:.0f}M"


def local(ms, fmt):
    return time.strftime(fmt, time.localtime(ms / 1000))


def main():
    try:
        st = json.load(sys.stdin)
    except Exception:
        print(c("31", "El watchdog no responde…"))
        return
    now = st["now"]
    services = st.get("services", [])
    bad = sum(1 for s in services if s["state"] != "running" or s["health"] == "unhealthy")
    bad += len(st.get("problems", []))
    head = c("32;1", "Todo funciona") if not bad else c("31;1", f"{bad} problema(s)")
    print(f"{c('1', 'GateWayNK')}  {head}  {c('2', time.strftime('%H:%M:%S'))}  {c('2', '(Ctrl+C para salir)')}\n")

    print(c("2", f"{'SERVICIO':<16}{'ESTADO':<14}{'EN MARCHA':>10}{'CPU':>8}{'RAM':>8}{'REINICIOS':>11}"))
    for s in services:
        if s["state"] != "running":
            est, col = s["state"], "31"
        elif s["health"] == "unhealthy":
            est, col = "no responde", "31"
        elif s["health"] == "starting":
            est, col = "arrancando", "33"
        else:
            est, col = ("sano" if s["health"] == "healthy" else "en marcha"), "32"
        cpu = "—" if s.get("cpu") is None else f"{s['cpu']:.1f}%"
        up = dur(s["upMs"]) if s["state"] == "running" else "—"
        print(f"{s['name']:<16}{c(col, f'{est:<14}')}{up:>10}{cpu:>8}{size(s.get('memBytes')):>8}{s.get('restartCount', 0):>11}")
    print()

    wa = st.get("whatsapp")
    if wa:
        print(f"WhatsApp: {c('32' if wa['ok'] else '33', wa['status'])} (desde hace {dur(now - wa['since'])})")
    for name, chk in (st.get("publicChecks") or {}).items():
        state = c("32", "responde") if chk["ok"] else c("31", "NO responde")
        print(f"{name}: {state} (hace {dur(now - chk['checkedAt'])})")
    b = st.get("backup")
    if b and b.get("ok") is not None:
        state = c("32", "correcta") if b["ok"] else c("31", "FALLIDA")
        print(f"Copia de seguridad: {state} hace {dur(now - b['atMs'])}")
    disk = st.get("disk")
    if disk:
        print(f"Disco libre: {size(disk['freeBytes'])}")

    g = st.get("gateway")
    if g:
        last = g.get("minutes", [])[-5:]
        total = sum(m["count"] for m in last)
        tls = sum(m["tls"] for m in last)
        err = sum(m["s5"] for m in last)
        print(f"Tráfico (5 min): {total} peticiones, {tls} por HTTPS, {c('31', err) if err else 0} errores")
        recent = g.get("recent", [])[-6:][::-1]
        if recent:
            print(c("2", "\nÚltimas peticiones:"))
        for r in recent:
            code = r["status"]
            col = "31" if code >= 500 or code == 0 else "33" if code >= 400 else "0"
            via = "HTTPS" if r["via"] == "TLS" else "HTTP"
            print(f"  {local(r['at'], '%H:%M:%S')} {via:<5} {r['method']} {r['path'][:60]} → {c(col, code or 'cortada')} {r['ms']}ms")

    events = [e for e in st.get("events", []) if e["level"] != "INFO"][-4:][::-1]
    if events:
        print(c("2", "\nÚltimos avisos:"))
        for e in events:
            mark = c("31", "✘") if e["level"] == "ALERTA" else c("32", "✔")
            print(f"  {local(e['at'], '%d/%m %H:%M')} {mark} {e['message'][:100]}")


main()
