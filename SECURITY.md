# Auditoría de seguridad del repositorio

Fecha de la auditoría base: 2026-11-06. Ampliación del modo por fases:
2026-11-09. Alcance: archivos versionados, archivos nuevos del modo por fases e
historial git completo.

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

## Modo por fases (2026-11-09)

Archivos nuevos revisados: `agents/implementer.md`, `agents/plan-reviewer.md`,
`tools/factory/{plan,plan-db,plan-review,subtasks,phase,scheduler,routing,paths}.ts`,
`plugins/factory/migrations/004_orchestration.sql` y `docs/orchestration.md`.

- `gitleaks dir . --redact` sobre el árbol de trabajo (incluye los archivos
  nuevos): **5 hallazgos, todos en archivos no versionados y ya conocidos**:
  `service.json`, dos fixtures de `plugins/factory/rules/packs/default.yml` y las
  dos copias del backup `backups/orchestration-20261109-220346/`. Ninguno está
  en el código de la fábrica ni se publica.
- `grep` manual de DSN con contraseña, claves privadas y tokens: **sin
  hallazgos** en agentes, tools, plugin, docs, skills y README.
- Las migraciones 004 y 005 son aditivas: crean tablas de plan, añaden
  `tasks.author_model`, la severidad por ronda y el estado `exhausted`; no
  modifican `memories` ni `capture_state`.
- No se guardan secretos en `plans`, `plan_tasks`, `subtask_runs` ni
  `phase_closures`. Los prompts pasan rutas y diffs, no credenciales.

### Aislamiento de subagentes

- `implementer` arranca con una política de sesión que solo permite `edit`
  dentro de `${worktree}/**` y `external_directory` sobre ese worktree; shell,
  subagentes y `review_submit` quedan denegados. Además, `subtask_run` compara
  el diff real con `files_owned` y rechaza la tarea si toca algo fuera. Son dos
  capas independientes: aunque una sesión saltara la política, el diff no se
  integra.
- `plan-reviewer`, `code-reviewer`, `security-reviewer` y `qa-engineer` son de
  solo lectura y no reciben permiso de edición. El orquestador tiene
  `review_submit` denegado para que no pueda aprobar su propio trabajo.
- Los worktrees viven fuera del repo, en
  `~/.local/share/opencode/worktrees/<proyecto>/`. `factory_doctor` los audita,
  detecta `.git` roto y `plan_resume` reconcilia los que quedan huérfanos.
- `subtask_integrate` aborta si la rama toca archivos fuera de `files_owned` y
  solo fusiona en `factory/integration/<proyecto>`; nunca en `main`, `master` ni
  `develop`.

### Datos y limpieza

- Los planes, tareas, revisiones y cierres se guardan en PostgreSQL. Al
  desinstalar, revierte las migraciones 005 y 004 en ese orden, solo después de
  hacer backup y de confirmar que no necesitas esos datos; el SQL está en
  `docs/orchestration.md` §8.
- Los worktrees y ramas de tareas se eliminan a mano tras integrar. No borres
  `memories` ni `capture_state`: son datos del plugin de memoria, no de la
  fábrica.

## Skills de Anthropic (2026-11-10)

Se probaron 19 skills de `anthropics/skills` (commit
`2c5958ecac7cee2b583967a2c4981d0f4a75c579`). **No se versionan**: quedan en
`~/.local/share/opencode/skills-local/anthropic/` y el repo solo conserva las
skills propias `factory-*`.

- `gitleaks dir` sobre el zip extraído: **0 hallazgos**.
- Licencias: 14 Apache-2.0 con `LICENSE.txt`; `docx`, `pdf`, `pptx` y `xlsx`
  son source-available y **no redistribuibles**; `doc-coauthoring` no trae
  licencia. Ver `THIRD-PARTY.md` y `docs/skills-import.md`.
- No se importaron secretos, `.env`, claves ni credenciales.
- Las skills con ID en conflicto con skills integradas (`docx`, `pdf`, `pptx`,
  `xlsx`, `skill-creator`) se renombraron a `anthropic-*` en local; no se
  versionan.
- La importación no instala dependencias. `docs/skills-import.md` lista las que
  cada skill declara.

## Antes de hacer público

1. Decidir licencia del repositorio.
2. Revisar la plantilla `opencode.example.json` y decidir si se publica tal cual
   o con los MCP de ROCm eliminados.
3. Confirmar que `service.json`, `secrets/` y los packs siguen fuera del índice.
4. Volver a ejecutar `gitleaks git . --redact` y `gitleaks dir . --redact` tras
   cualquier cambio; revisa que los únicos hallazgos sigan siendo los archivos
   no versionados conocidos.
