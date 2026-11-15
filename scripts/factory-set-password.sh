#!/usr/bin/env bash
# Genera una contraseña local para la consola y la guarda en ui/.env.local.
# No imprime el secreto: indica el archivo para consultarlo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT/ui/.env.local"
UMASK_ORIGINAL="$(umask)"
umask 077

PASSWORD="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
if [ -f "$TARGET" ]; then
  grep -v -E '^(FACTORY_UI_PASSWORD|FACTORY_UI_REQUIRE_AUTH)=' "$TARGET" > "$TARGET.tmp" || true
  mv "$TARGET.tmp" "$TARGET"
fi
{
  echo "FACTORY_UI_PASSWORD=$PASSWORD"
  echo "FACTORY_UI_REQUIRE_AUTH=1"
} >> "$TARGET"
chmod 600 "$TARGET"
umask "$UMASK_ORIGINAL"

if systemctl --user is-enabled --quiet factory-ui.service 2>/dev/null; then
  systemctl --user restart factory-ui.service
  echo "Contraseña guardada en $TARGET (modo 600) y servicio reiniciado."
else
  echo "Contraseña guardada en $TARGET (modo 600)."
fi
echo "Consulta la contraseña con: cat \"$TARGET\""
