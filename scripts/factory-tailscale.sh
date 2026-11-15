#!/usr/bin/env bash
# Estado y activación de Tailscale Serve para la consola.
# Usa el puerto 8443 para no chocar con otros servicios en 443 (por ejemplo el host principal).
# La consola exige login propio; no expongas el puerto sin auth.
set -euo pipefail

PORT="${FACTORY_UI_PORT:-4173}"
SERVE_PORT="${FACTORY_TAILSCALE_PORT:-8443}"
ACTION="${1:-status}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require_tailscale() {
  command -v tailscale >/dev/null 2>&1 || {
    echo "Tailscale no está instalado." >&2
    exit 1
  }
}

has_password() {
  [ -n "${FACTORY_UI_PASSWORD:-}" ] && return 0
  grep -q '^FACTORY_UI_PASSWORD=.' "$ROOT/ui/.env.local" 2>/dev/null && return 0
  node -e '
    const fs=require("node:fs"); const p=process.env.HOME+"/.config/opencode/service.json";
    try { const v=JSON.parse(fs.readFileSync(p,"utf8")); process.exit(typeof v.password==="string" && v.password.length>0 ? 0 : 1); }
    catch { process.exit(1); }
  ' 2>/dev/null
}

case "$ACTION" in
  status)
    require_tailscale
    tailscale status --json 2>/dev/null | node -e '
      let raw=""; process.stdin.on("data",c=>raw+=c).on("end",()=>{
        try { const s=JSON.parse(raw); console.log(`Cuenta: ${s.User?.[s.Self?.UserID]?.LoginName ?? "?"}`); console.log(`Equipo: ${s.Self?.DNSName?.replace(/\.$/,"") ?? "?"}`); console.log(`Online: ${s.Self?.Online ? "sí" : "no"}`); }
        catch { console.log("No se pudo leer el estado de Tailscale."); }
      });'
    echo "--- Serve actual ---"
    tailscale serve status || true
    echo "--- Comando para exponer esta consola ---"
    echo "  ./scripts/factory-tailscale.sh enable"
    ;;
  enable)
    require_tailscale
    if ! has_password; then
      echo "Falta una contraseña de consola. Ejecuta ./scripts/factory-set-password.sh primero." >&2
      exit 1
    fi
    echo "Publicando la consola en https://<equipo>:$SERVE_PORT/ (solo tailnet)."
    tailscale serve --bg --https="$SERVE_PORT" "http://127.0.0.1:$PORT"
    tailscale serve status
    echo "Abre la URL desde un dispositivo de tu tailnet e inicia sesión con FACTORY_UI_PASSWORD."
    ;;
  disable)
    require_tailscale
    echo "Quitando la publicación en el puerto $SERVE_PORT (no toca otros puertos)."
    if ! tailscale serve --https="$SERVE_PORT" off; then
      echo "No se pudo retirar el puerto $SERVE_PORT. Estado actual (sin cambios):" >&2
      tailscale serve status >&2 || true
      exit 1
    fi
    tailscale serve status || true
    ;;
  *)
    echo "Uso: $0 [status|enable|disable]" >&2
    exit 2
    ;;
esac
