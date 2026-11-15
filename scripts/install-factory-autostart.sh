#!/usr/bin/env bash
# Instala el arranque automático de la consola (systemd de usuario) y deja un
# lanzador de escritorio que abre la página al iniciar la sesión gráfica.
# No imprime secretos. Es idempotente.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
PORT="${FACTORY_UI_PORT:-4173}"

if [ ! -x "$NODE_BIN" ]; then
  echo "No encontré node. Instálalo o define NODE_BIN." >&2
  exit 1
fi

if [ ! -f "$ROOT/ui/dist/index.html" ]; then
  echo "Compilando la consola…"
  (cd "$ROOT/ui" && npm run build)
fi

mkdir -p "$UNIT_DIR" "$AUTOSTART_DIR"

cat > "$UNIT_DIR/factory-ui.service" <<EOF
[Unit]
Description=Factory Console (OpenCode v2)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT/ui
ExecStart="$NODE_BIN" server/index.mjs
Environment=FACTORY_UI_HOST=127.0.0.1
Environment=FACTORY_UI_PORT=$PORT
EnvironmentFile=-$ROOT/ui/.env.local
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

cat > "$AUTOSTART_DIR/factory-console.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Factory Console
Comment=Abre la consola de la fábrica al iniciar sesión
Exec=sh -c 'sleep 4; xdg-open http://127.0.0.1:$PORT'
Icon="$ROOT/ui/public/icons/icon-192.png"
Terminal=false
X-GNOME-Autostart-enabled=true
EOF

systemctl --user daemon-reload
systemctl --user enable factory-ui.service

if systemctl --user is-active --quiet factory-ui.service; then
  systemctl --user restart factory-ui.service
else
  systemctl --user start factory-ui.service
fi

sleep 1
if systemctl --user is-active --quiet factory-ui.service; then
  echo "Listo: factory-ui.service activo en http://127.0.0.1:$PORT"
  echo "El servicio arranca OpenCode si no está levantado."
  echo "La página se abrirá al iniciar la sesión gráfica (XDG autostart)."
else
  echo "El servicio no arrancó. Revisa: journalctl --user -u factory-ui.service -n 50" >&2
  exit 1
fi
