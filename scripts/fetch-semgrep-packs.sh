#!/usr/bin/env bash
# Descarga los packs de Semgrep usados por factory. No se versionan porque
# están bajo la Semgrep Rules License v1.0 (https://semgrep.dev/legal/rules-license).
#
# Uso: scripts/fetch-semgrep-packs.sh [directorio-destino]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$ROOT/plugins/factory/rules/packs}"
mkdir -p "$DEST"

PACKS=(
  default
  owasp-top-ten
  javascript
  python
  php
  java
  ruby
  golang
  rust
  csharp
)

for pack in "${PACKS[@]}"; do
  printf 'descargando %s...\n' "$pack"
  curl -L --fail --silent --show-error \
    "https://semgrep.dev/c/p/$pack" \
    -o "$DEST/$pack.yml"
done

printf 'Packs en %s\n' "$DEST"
printf 'Licencia: Semgrep Rules License v1.0; revisa https://semgrep.dev/legal/rules-license\n'
