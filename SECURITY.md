# Auditoría de seguridad del repositorio

Fecha: 2026-11-06. Alcance: archivos versionados e historial git completo.

## Resultado

- `git ls-files`: solo configuración, agentes, skills, tools, migraciones y el
  plugin `factory`. No incluye `secrets/`, `service.json`, backups, packs de
  Semgrep, `node_modules` ni `plugins/opencode-memory`.
- `gitleaks git . --redact`: **sin hallazgos** en el historial completo.
- `gitleaks dir` sobre un `git archive HEAD`: **sin hallazgos** en el snapshot
  exacto que se publica.
- `gitleaks dir . --redact`: 3 hallazgos en archivos **no versionados**:
  - `service.json`: contraseña local (`generic-api-key`). Excluido por `.gitignore`.
  - `plugins/factory/rules/packs/default.yml`: dos fixtures de reglas
    (`private-key` y `slack-webhook-url`). Packs excluidos y descargados aparte.

## Revisión manual de configuración

- `opencode.json`: es local y está excluido. La plantilla versionada
  `opencode.example.json` no contiene claves ni rutas personales: usa
  `{env:ROCM_MCP_DIR}` y `{env:CONTEXT7_TOKEN}`. Si prefieres un archivo para el
  token, cambia el header a `Bearer {file:./secrets/context7-token}`; ese
  archivo está fuera del repositorio. Los MCP `rocminfo` y `amd-smi` son
  comandos locales sin credenciales.
- `cli.json`: preferencias de interfaz, sin secretos.
- `service.json`: contiene una contraseña local; nunca se versiona.
- `secrets/context7-token`: token local; nunca se versiona.
- `plugins/opencode-memory/`: excluido. La copia local no declara autor ni
  licencia verificable. El paquete npm homónimo es MIT
  (<https://github.com/shuans/opencode-memory>), pero no se pudo confirmar que
  esta copia sea esa distribución.
- `tools/factory/db.ts` y `plugins/factory/index.ts`: DSN local de desarrollo sin
  contraseña (`postgres://opencode@127.0.0.1:5433/opencode_memory`),
  sobreescribible con `FACTORY_DATABASE_URL` o `OPENCODE_MEMORY_DATABASE_URL`.
- `package-lock.json`: solo URLs del registry de npm.
- Packs de Semgrep: cabecera `Semgrep Rules License v1.0`
  (<https://semgrep.dev/legal/rules-license>); no se redistribuyen. Se descargan
  con `scripts/fetch-semgrep-packs.sh`.

## Antes de hacer público

1. Decidir licencia del repositorio.
2. Revisar la plantilla `opencode.example.json` y decidir si se publica tal cual
   o con los MCP de ROCm eliminados.
3. Confirmar que `service.json`, `secrets/` y los packs siguen fuera del índice.
4. Volver a ejecutar `gitleaks git . --redact` tras cualquier cambio.
