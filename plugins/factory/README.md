# opencode-factory

Fábrica de software genérica para OpenCode V2. Instalación global en `~/.config/opencode/`.

## Qué incluye

| Agente | Modo | Modelo | Rol |
|---|---|---|---|
| `factory` | primary | `opencode-go/deepseek-v4.1-flash` | Orquesta, hace onboarding, implementa, verifica y delega. |
| `security-reviewer` | subagent | `opencode-go/glm-5.3-flash` | Revisión de seguridad de solo lectura con veredicto fijo. |
| `code-reviewer` | subagent | `opencode-go/claude-haiku-5-5` | Diseño, mantenibilidad, errores y convenciones. |
| `qa-engineer` | subagent | `opencode-go/minimax-m3` | QA adversarial, tests de borde y evidencia por criterio. |
| `helper` | subagent | `opencode-go/glm-5.3-flash` | Segunda opinión, documentación con citas e ideas de tests. |
| `plan-reviewer` | subagent | `opencode-go/claude-haiku-5-5` | Revisión del plan por fases; solo lectura. |
| `implementer` | subagent | `opencode-go/glm-5.3-flash` | Tarea pequeña y aislada en su worktree; sin shell ni commit. |
| `product-analyst` | subagent | `opencode-go/glm-5.3` | Requisitos y criterios verificables; no decide arquitectura. |
| `architect` | subagent | `opencode-go/glm-5.3` | Diseño, contratos y ADR; no implementa. |
| `tech-writer` | subagent | `opencode-go/glm-5.3-flash` | README, CHANGELOG, guías y runbooks; no cambia especificaciones. |
| `devops-engineer` | subagent | `opencode-go/glm-5.3` | Docker, CI/CD, entornos, health checks y rollback; no despliega producción sin aprobación. |

| Tool | Qué hace |
|---|---|
| `project_detect` | Detecta stack y comandos candidatos sin ejecutarlos. |
| `project_profile_get` | Lee el perfil exacto del proyecto desde PostgreSQL. |
| `project_profile_set` | Guarda stack, comandos verificados, convenciones y notas. |
| `task_create` / `task_update` / `task_list` | Tablero de tareas por proyecto. |
| `run_checks` | Ejecuta install/lint/typecheck/test/build según el perfil; devuelve hallazgos archivo:línea. |
| `run_gates` | Compuertas deterministas, baseline, política y registro en `gate_runs`. |
| `security_scan` | semgrep/gitleaks/osv-scanner/trivy en modo `offline` (default) u `online`; reporta red y ausentes. |
| `review_submit` | Guarda el veredicto del revisor y el uso/costo de su sesión en `review_runs`. |
| `task_close` | Cierra una tarea solo con gates, revisiones, evidencia y memoria; guarda el informe con tokens y costo por modelo. |
| `plan_create` / `plan_update` / `plan_status` | Plan por fases, tareas, dependencias, olas, deuda residual y waiver. |
| `plan_validate` / `plan_review` | Validación determinista y revisión por severidad; `exhausted` pide decisión humana. |
| `subtask_run` | Worktree en `~/.local/share/opencode/worktrees/<proyecto>/` + rama + sesión `implementer`. |
| `review_run` | Lanza code/security/qa con modelos de familia distinta al autor y exige `review_submit`. |
| `subtask_integrate` | Integra en `factory/integration/<proyecto>` con `--no-ff`; aborta conflictos. |
| `phase_close` / `plan_resume` | Cierre de fase con gate, revisiones, memoria e informe; reanudación de sesiones/worktrees. |
| `git_branch` | Crea o reutiliza una rama de tarea; rechaza ramas protegidas. |
| `git_commit` | Stagea y commitea solo en rama no protegida; único camino permitido. |
| `quality_policy_set` | Cambia la política de compuertas; exige `confirmed=true`. |
| `model_catalog_sync` / `model_catalog_list` / `agent_catalog_list` | Catálogo MAM de modelos y agentes. |
| `model_profile_*` / `mam_status` | Perfiles de ejecución, asignación de modelo por rol, validación, aplicación y resumen. |
| `factory_agents_*` | Selección de agentes por proyecto, recomendación determinística y permisos `subagent` de la sesión. |
| `budget_list` / `budget_set` | Presupuesto global, de fase y de tarea. |
| `executions_list` / `model_history` | Execution log y evaluación de modelos por éxito/coste. |
| `factory_doctor` | Diagnostica PostgreSQL, migraciones, escáneres, packs, modelos/agentes, plugin de memoria y tools. |

Las tools base de memoria (`memory_search`, `memory_save`, `memory_forget`,
`memory_capture_now`, `memory_stats`) son las del plugin `opencode-memory` ya
existente. La fábrica añade la capa de memoria viva:
`memory_upsert` (entidad y NOOP/UPDATE/CREATE con historial), `memory_backup`,
`memory_consolidation_plan` (dry-run), `memory_consolidation_apply` (backup,
soft delete con `merged_into`, execution log y verificación) y
`memory_consolidation_verify`. Aplicar exige `confirmed=true`; los clusters con
conflictos o confianza baja exigen `approve_low_confidence=true`.

El plugin también expone un RPC en `/api/rpc/opencode.factory/*` para la consola
web: `health`, `models.*`, `agents.list`, `profiles.*`, `work.*`, `memory.*` y
`analytics.summary`, `budgets.*`, `executions.list`, `models.history` y
`agents.*`. Las mutaciones de perfiles/presupuestos exigen `confirmed=true` y se
auditan; el perfil aplicado se guarda por location y se restaura al recargar.

## Skills

Los procedimientos largos viven en `~/.config/opencode/skills/` y se cargan bajo demanda:

- `factory-onboarding`
- `factory-intake`
- `factory-task-triage`
- `factory-task-loop`
- `factory-quality-gates`
- `factory-review-loop`
- `factory-security-review`
- `factory-git-safety`
- `factory-phase-orchestration`
- `factory-pipeline`
- `factory-deployment`
- `factory-closure-report`

El prompt de `factory` solo indica cuándo cargar cada una. Se pueden editar sin tocar el agente.

Las 19 skills de `anthropics/skills` que se probaron **no se versionan** en este
repositorio: quedan en `~/.local/share/opencode/skills-local/anthropic/`. Las de
documentos (`docx`, `pdf`, `pptx`, `xlsx`) son source-available y no se
redistribuyen; `doc-coauthoring` no trae licencia. El detalle y las licencias
están en `~/.config/opencode/docs/skills-import.md`.

## Uso

1. Abre un repo con OpenCode. `factory` es el agente por defecto.
2. Pídele una tarea normal. En la primera sesión hará onboarding:
   - `project_profile_get`
   - lectura de `AGENTS.md` / `README` / manifiestos
   - `project_detect`
   - verificación real de comandos
   - `project_profile_set` con `verified: true`
3. Para una tarea: crea tareas pequeñas, trabaja en rama `factory/<slug>`, implementa, ejecuta `run_gates`, corrige los bloqueantes, pasa `@qa-engineer` + `@code-reviewer` + `@security-reviewer` (si aplica); **cada revisor llama a `review_submit`**, commitea con `git_commit`, guarda memoria y cierra con `task_close`.
4. Para cambiar de agente en la TUI, usa el selector de agentes; `factory` solo es el default de sesiones nuevas.
5. Si algo falla tras una actualización, llama a `factory_doctor` antes de tocar la base o el plugin.

### Modo por fases

Para un proyecto existente con un documento de fases:

1. `factory-intake` (skill): baseline, riesgos de seguridad y diff de fases propuesto.
2. `plan_create` y `plan_review` (2 rondas normales; tercera con `confirmed=true` tras `exhausted`); registra hallazgos aceptados o refutados en `plan_update`. Un `CRÍTICO` no se refuta ni se waivea: exige una ronda posterior aprobada sin él.
3. `plan_validate`; `CRÍTICO`/`ALTO` bloquean, `MEDIO`/`BAJO` son deuda. Aprueba con `plan_update({ status: "approved", confirmed: true })` o decide `approve_with_waiver`/`fix_and_revalidate`/`cancel` si la revisión está `exhausted`.
4. `plan_status` para ver la ola; `subtask_run` ejecuta tareas `implementer` en paralelo en worktrees.
5. `run_gates({ worktree })` y `review_run`; cada revisor llama a `review_submit`.
6. `subtask_integrate` en `factory/integration/<proyecto>`.
7. `run_gates` sobre la integración y `phase_close` con `memory_id`, `residual_risks` y `confirmed` en autonomía `supervised`.
8. `plan_resume` tras una interrupción; `factory_doctor` audita worktrees huérfanos y tareas colgadas.

La guía completa, el esquema y la desinstalación están en
`~/.config/opencode/docs/orchestration.md`.

## Compuertas

`run_gates` ejecuta, en orden de coste: format, lint, typecheck, build, test, coverage, security, dependencies, static, e2e, accessibility, api, migrations y, solo bajo petición, mutation/performance.

- `pass|fail|skipped|error` por compuerta; un `skipped` siempre lleva razón y nunca cuenta como pass.
- `baseline` en onboarding; solo los hallazgos nuevos bloquean. La deuda previa se reporta aparte.
- Política por defecto: build, lint, typecheck, test, secretos y vulnerabilidades críticas/altas bloquean; cobertura avisa. Se puede activar cobertura como bloqueante por proyecto con `quality_policy_set` y confirmación explícita.
- PHP sin Xdebug/PCOV: coverage `skipped` con razón.
- Si un escáner falla, la compuerta de seguridad es `error`, no `pass`.
- `task_close` calcula `security_applicable` del diff: SQL, entradas de usuario, auth/sesión/permisos, archivos/subidas/borrado, red, secretos y dependencias. Si el diff toca esas categorías y se pasa `security_applicable: false`, exige `security_justification` y la guarda en `closure_report.security`.

Ejemplos:

```text
Onboardéate en este repo y guarda el perfil verificado.
```

```text
Crea una tarea para añadir validación al endpoint /users, impleméntala,
ejecuta run_checks, pásale el diff a @security-reviewer y haz commit.
```

```text
Revisa este cambio con @security-reviewer y dime si hay algún riesgo de inyección.
```

## Tokens y costo en el cierre

`review_submit` guarda el uso de la sesión del revisor (`session_id`, input,
output, reasoning, caché lectura/escritura, costo y fuente). `task_close` vuelve
a leer esa sesión para incluir la respuesta final y añade el uso de la sesión del
orquestador. El informe de cierre incluye `usage.per_model` y `usage.totals`.

- Si el proveedor reporta `cost > 0`, se usa tal cual (`cost_source: "provider"`).
- Si no, se estima con el catálogo de modelos visible en OpenCode
  (`cost_source: "catalog"`), en USD por millón de tokens. Los tokens de
  razonamiento se facturan a precio de salida.
- Si no hay precio, queda `unknown` con costo 0; no se inventa una cifra.
- El costo del orquestador es el acumulado de su sesión y puede incluir otras
  tareas; el informe lo etiqueta como tal. No es una factura.

Fórmula de la estimación (precios en USD por millón de tokens):

```text
cost_usd = (
  input * price_input +
  (output + reasoning) * price_output +
  cache_read * price_cache_read +
  cache_write * price_cache_write
) / 1_000_000
```

Los tramos de contexto del catálogo se aplican cuando el tamaño observado de la
sesión supera su umbral. No se modelan descuentos horarios ni promociones.

## Stacks detectados

`project_detect` reconoce Node/TypeScript, Python, PHP/Composer, PHP plano con
MySQL, Java Maven, Java Gradle, Ruby/Bundler, .NET, Rust, Go y Make. Devuelve
`stack.tools` con la disponibilidad real de cada binario y `warnings` cuando
falta una herramienta; no inventa comandos de test/lint que no existan.

## Base de datos

Reutiliza la misma PostgreSQL/pgvector de `opencode-memory` (host, puerto y base
locales configurados por ese plugin). Solo añade:

- `factory_projects`: perfil exacto por `project_id` (incluye `quality` y `baseline`).
- `tasks`: tareas por `project_id` (incluye `closure_report` y `closed_at`).
- `gate_runs`: cada ejecución de compuertas por tarea e iteración.
- `review_runs`: veredictos estructurados de revisores, sesión, tokens y costo.
- `plans`: plan por fases, autonomía, concurrencia, documentos y estado de revisión/validación.
- `plan_tasks`: tareas del plan, fase, dependencias, `files_owned`, worktree, rama y estado.
- `plan_reviews` / `plan_validations`: rondas del plan-reviewer e historial determinista.
- `subtask_runs`: cada intento de implementer con sesión, worktree, tokens y costo.
- `phase_closures`: cierre por fase con gate, revisiones, informe y uso.
- `tasks.author_model`: modelo autor para elegir revisores de otra familia.
- `factory_meta`: versión de esquema y perfil aplicado por location.
- `factory_models`, `factory_agent_catalog`, `factory_execution_profiles`, `factory_profile_assignments`, `factory_audit_events`, `factory_execution_log`: MAM.
- `factory_budgets`, `factory_budget_reservations`, `factory_model_prices`: presupuesto y precios.

La 009 añade a `memories` la entidad, documento estructurado, historial, soft
delete y `memory_backups`; no borra memorias. Migraciones idempotentes:
`plugins/factory/migrations/001_factory.sql`, `002_quality_gates.sql`,
`003_usage.sql`, `004_orchestration.sql`, `005_review_severity.sql` y
`006_model_agent_management.sql`, `007_execution_budgets.sql`,
`008_budget_units.sql` y `009_memory_lifecycle.sql` (`schema_version=9`). La 006
añade catálogo MAM, perfiles, asignaciones, auditoría y registro de ejecución; la
007 añade presupuestos, reservas atómicas y precios versionados; la 008 renombra
`max_tokens` a `token_budget`, separa tokens ponderados y registra sobreconsumo;
la 009 añade la memoria viva y sus backups.

Se puede cambiar la base con `FACTORY_DATABASE_URL` o
`OPENCODE_MEMORY_DATABASE_URL`; nunca se registra la URL completa.

## Escáneres y modo offline

`security_scan` no instala nada. Si faltan binarios, devuelve `missing` con una
pista. Por defecto usa `mode: "offline"`:

- **semgrep**: `--metrics=off`, packs vendorizados (`p/default`, `p/owasp-top-ten`
  y el pack del stack) + reglas locales. No usa `--config auto`; se pueden pasar
  varios `--config`.
- **gitleaks**: `gitleaks dir`, `--redact`; no usa red.
- **osv-scanner**: `scan source --offline --offline-vulnerabilities` contra la
  caché local; si no hay caché, devuelve `skipped`.
- **trivy**: `--skip-db-update --offline-scan` contra la DB local; si no hay DB,
  devuelve `skipped`.

Prepara las cachés una vez (requiere red):

```bash
# OSV: ejecutar en un repo con lockfile para descargar la DB global
osv-scanner scan source --offline --offline-vulnerabilities \
  --download-offline-databases -r .

# Trivy: descarga la DB local (~1.6 GB en este equipo)
trivy fs --download-db-only

# Semgrep: refrescar los packs vendorizados (opcional)
for p in default owasp-top-ten javascript python php java ruby golang rust csharp; do
  curl -L -sS "https://semgrep.dev/c/p/$p" \
    -o ~/.config/opencode/plugins/factory/rules/packs/$p.yml
done
```

Para una revisión que requiera reglas actualizadas o consultar OSV API, usa
`mode: "online"`. La tool siempre reporta `network` y `config` por escáner.

## Modelo del revisor de seguridad

`security-reviewer` usa `opencode-go/glm-5.3-flash`, `code-reviewer`
`opencode-go/claude-haiku-5-5` y `qa-engineer` `opencode-go/minimax-m3`.

A/B interno con fallos clásicos y no clásicos (TOCTOU, mass assignment, SSRF, JWT
alg none): los tres empataron. En el benchmark externo de 8 módulos (SQLi ORDER
BY, CSRF por GET, zip slip, ReDoS, prototype pollution, deserialización,
enumeración y path traversal en subida), con el mismo prompt y sin adaptarlo:

- GLM 5.3 Flash: 8/8 en la última ejecución (en una anterior dio 6/8).
- Kimi K2.7 Code: 7/8; falla ReDoS, pero sí cubre prototype pollution y
  enumeración.
- GPT-6 Luna: 4/8 confirmados más SQLi ORDER BY como sospecha; no cubre ReDoS,
  prototype pollution ni enumeración.

Kimi cuesta varias veces más que GLM (en la última medición ~4,5x) y no fue
mejor en cobertura global, así que se mantiene GLM. GPT-6 Luna es algo más
barato en input, pero con retención de 30 días frente a 0 de GLM y peor
cobertura. En code/QA, Claude y MiniMax detectaron todos los criterios
sembrados; se mantienen por su especialización.

En el modo por fases, `tools/factory/routing.ts` aplica la regla de familia:
si el autor es GLM, seguridad usa DeepSeek; si el autor es Claude, código usa
DeepSeek; QA usa MiniMax o GPT-6 Luna para tareas simples. `subtask_run` puede
fijar el modelo del implementer por tarea. Kimi K2.7 queda fuera del ruteo
normal y solo se usa como escalado manual para bugs o arquitectura compleja.

## Desinstalar

```bash
cd ~/.config/opencode

# 1. Restaura tu opencode.json/AGENTS.md desde tu backup local si lo tienes.
#    Este repo no versiona backups ni tu configuración local.

# 2. Borrar agentes, plugin, tools, docs y skills
rm -f agents/factory.md agents/security-reviewer.md agents/code-reviewer.md \
      agents/qa-engineer.md agents/helper.md agents/researcher.md \
      agents/implementer.md agents/plan-reviewer.md
rm -rf plugins/factory tools/factory docs/orchestration.md
rm -rf skills/factory-onboarding skills/factory-intake \
       skills/factory-task-triage skills/factory-task-loop \
       skills/factory-quality-gates skills/factory-review-loop \
       skills/factory-security-review skills/factory-git-safety \
       skills/factory-phase-orchestration skills/factory-closure-report

# 3. Opcional: borrar las tablas/columnas de la fábrica (conserva la memoria)
#    Si quieres conservar los planes, revierte 005 con el SQL completo de
#    docs/orchestration.md §8.2 (incluye constraints y columnas).
psql -h 127.0.0.1 -p 5433 -U opencode -d opencode_memory \
  -c 'DROP TABLE IF EXISTS phase_closures; DROP TABLE IF EXISTS subtask_runs; DROP TABLE IF EXISTS plan_validations; DROP TABLE IF EXISTS plan_reviews; DROP TABLE IF EXISTS plan_tasks; DROP TABLE IF EXISTS plans;'
psql -h 127.0.0.1 -p 5433 -U opencode -d opencode_memory \
  -c 'DROP TABLE IF EXISTS review_runs; DROP TABLE IF EXISTS gate_runs; DROP TABLE IF EXISTS factory_meta;'
psql -h 127.0.0.1 -p 5433 -U opencode -d opencode_memory \
  -c 'ALTER TABLE tasks DROP COLUMN IF EXISTS closure_report, DROP COLUMN IF EXISTS closed_at, DROP COLUMN IF EXISTS author_model;'
psql -h 127.0.0.1 -p 5433 -U opencode -d opencode_memory \
  -c 'ALTER TABLE factory_projects DROP COLUMN IF EXISTS quality, DROP COLUMN IF EXISTS baseline, DROP COLUMN IF EXISTS baseline_at, DROP COLUMN IF EXISTS autonomy, DROP COLUMN IF EXISTS max_concurrency;'
psql -h 127.0.0.1 -p 5433 -U opencode -d opencode_memory \
  -c 'DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS factory_projects;'
```

Los worktrees y ramas de tareas no se borran solos: viven en
`~/.local/share/opencode/worktrees/<proyecto>/` y se limpian a mano después de
integrar. Después, `/reload` o reinicia OpenCode para que desaparezcan del
catálogo. La guía con backup, orden de restauración y reversión de las
migraciones 005 y 004 está en `docs/orchestration.md` §8.

## Notas de diseño

- OpenCode V2 no auto-descubre tools sueltas en `tools/`; se registran desde un
  plugin con `ctx.tool.transform`. El código vive en `tools/factory/` y el plugin
  fino en `plugins/factory/`.
- Las tools que ejecutan shell (`run_checks`, `security_scan`) llaman a
  `ctx.permission.assert` antes de lanzar nada.
- Los datos exactos (comandos, perfiles) van a tablas normales; pgvector se
  reserva para decisiones y lecciones difusas.
