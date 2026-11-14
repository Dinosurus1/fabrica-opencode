#!/usr/bin/env bash
# Arranca la consola web de la fábrica en 127.0.0.1:4173.
# Instala dependencias y compila si hace falta. No imprime secretos.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/ui"

if [ ! -d node_modules ]; then
  npm ci
fi

if [ ! -f dist/index.html ]; then
  npm run build
fi

exec npm run start
