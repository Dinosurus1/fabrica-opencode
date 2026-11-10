# fabrica-opencode

Configuración global de **OpenCode V2** para convertir un repositorio en una
fábrica de software: onboarding, tareas verificables, compuertas deterministas,
revisores LLM, control de cierre y memoria persistente. Incluye un **modo por
fases** para planificar proyectos existentes, repartir tareas en subagentes
paralelos con worktrees y verificarlas antes de integrarlas.

Licencia **MIT** (ver `LICENSE`). Copyright (c) 2026 Dinosurus.

## Qué es

La fábrica vive en `~/.config/opencode/` y se compone de:

- `agents/`: orquestador (`factory`), subagentes de revisión, ayuda e
  investigación, y los agentes del modo por fases (`implementer` y
  `plan-reviewer`).
- `skills/`: procedimientos de onboarding, ingesta, triaje, tareas, compuertas,
  revisión, seguridad, git, orquestación por fases y cierre. Solo se versionan
  las skills propias `factory-*`; las de `anthropics/skills` quedan en local y
  no se redistribuyen (ver `docs/skills-import.md`).
- `tools/factory/`: tools de perfil, tareas, checks, compuertas, seguridad, git,
  revisiones, plan, worktrees, fases, reanudación y diagnóstico.
- `plugins/factory/`: registro de tools, migraciones SQL y reglas locales de
  Semgrep.
- `docs/orchestration.md`: guía del modo por fases, esquema, coste y
  desinstalación.
- `docs/skills-import.md`: origen, licencias, conflictos y modo de carga de las
  skills importadas.
- `docs/validation-stage-d.md`: resultados de la validación de casos de borde,
  paralelismo, fusión, `phase_close`, coste y bugs corregidos.
- `docs/plan-review-rules.md`: hallazgos abiertos de los planes de 6 fases y
  propuesta de aprobación por severidad y rondas agotadas.
- `opencode.example.json`: plantilla de configuración sin claves ni rutas
  personales.

La idea: cada tarea pasa por compuertas deterministas, revisores independientes
y un cierre con evidencia. El orquestador no puede aprobar su propio trabajo ni
cerrar una tarea sin compuertas en verde, revisiones aprobadas, memoria y
evidencia por criterio.

## Requisitos

- **OpenCode V2** (probado con `2.2.5`).
- **PostgreSQL + pgvector** para la memoria y las tablas de la fábrica.
- **Node.js 20+** y `npm` para las dependencias del plugin.
- Escáneres opcionales: **Semgrep**, **Gitleaks**, **OSV-Scanner** y **Trivy**.
- Opcional: PHP/Composer si vas a trabajar con repos PHP.
- Para cerrar tareas: `opencode-memory` o tablas `memories`/`capture_state`
  compatibles. No se incluye en este repositorio; ver `THIRD-PARTY.md`. Sin
  memoria, `factory_doctor` avisa y `task_close` no puede cerrar.

## Instalación paso a paso

### 1. Copiar la configuración

Si ya tienes `~/.config/opencode`, muévelo a un backup antes de clonar (si solo
lo copias, el directorio sigue existiendo y `git clone` falla):

```bash
mv ~/.config/opencode ~/.config/opencode.backup
git clone https://github.com/Dinosurus1/fabrica-opencode.git ~/.config/opencode
```

Si prefieres otro directorio, usa `OPENCODE_CONFIG_DIR` o copia los archivos a
`~/.config/opencode/`.

Para probar sin tocar tu configuración actual, clona en una carpeta temporal y
arranca con esa configuración y una base de prueba:

```bash
git clone https://github.com/Dinosurus1/fabrica-opencode.git /tmp/fabrica-opencode
cd /tmp/fabrica-opencode
cp opencode.example.json opencode.json
OPENCODE_CONFIG_DIR=/tmp/fabrica-opencode \
FACTORY_DATABASE_URL='postgres://opencode@127.0.0.1:5433/fabrica_install_test' \
opencode --standalone run --agent build "Llama a factory_doctor"
```

### 2. Configuración local

El repo no versiona `opencode.json` porque cada equipo tiene rutas y secretos
distintos. Crea el tuyo desde la plantilla:

```bash
cd ~/.config/opencode
cp opencode.example.json opencode.json
```

Edita `opencode.json`:

- `ROCM_MCP_DIR`: ruta del proyecto de MCP de ROCm. Si no usas `rocminfo` ni
  `amd-smi`, borra esos dos servidores.
- `CONTEXT7_TOKEN`: token de Context7. También puedes cambiar el header a
  `"Bearer {file:./secrets/context7-token}"` y guardar el token en ese archivo
  con permisos `600`.

`opencode.json` está en `.gitignore`; no se publica.

### 3. Dependencias del plugin

```bash
cd ~/.config/opencode/plugins/factory
npm ci
```

### 4. Packs de Semgrep

Los packs no se versionan por su licencia. Descárgalos con:

```bash
cd ~/.config/opencode
scripts/fetch-semgrep-packs.sh
```

Requiere red. Los guarda en `plugins/factory/rules/packs/`, ruta ignorada por
git.

### 5. Cachés offline de seguridad

`security_scan` usa modo `offline` por defecto. Prepara las cachés una vez
(requiere red):

```bash
# OSV: ejecuta dentro de un repo con lockfile/manifiesto
osv-scanner scan source --offline --offline-vulnerabilities \
  --download-offline-databases -r /ruta/al/repo

# Trivy: descarga la base local
trivy fs --download-db-only
```

Gitleaks no necesita caché. Semgrep usa los packs del paso anterior. En modo
`online`, `security_scan` consulta la red y lo declara en `network`.

### 6. Arranque y diagnóstico

Arranca o reinicia OpenCode (si ya había un servicio corriendo, no basta con
abrir otra ventana: reinícialo para que lea la configuración nueva). Al
registrar las tools, el plugin aplica las migraciones de
`plugins/factory/migrations/`. Comprueba:

```text
factory_doctor
```

Debe devolver `0 error`. Sin `opencode-memory` verás warnings por las tablas de
memoria y el plugin; no son errores de instalación. Si faltan escáneres, los
marca como ausentes; no los instala.

### 7. Base de datos

La fábrica reutiliza PostgreSQL/pgvector:

- `FACTORY_DATABASE_URL` o `OPENCODE_MEMORY_DATABASE_URL` si están definidas.
- Si no, usa el DSN local de desarrollo
  `postgres://opencode@127.0.0.1:5433/opencode_memory` (sin contraseña).

No modifica la tabla `memories` ni el esquema de `opencode-memory`; crea
`factory_projects`, `tasks`, `gate_runs`, `review_runs`, `plans`, `plan_tasks`,
`plan_reviews`, `plan_validations`, `subtask_runs`, `phase_closures` y
`factory_meta`. Las migraciones 004 y 005 son aditivas y dejan
`schema_version=5`; la 005 añade `review_exhausted`, `residual_findings`,
`approval_waiver` y las métricas por ronda del plan-reviewer.

`factory_doctor` da `warn` si faltan `memories` o `capture_state`. Sin memoria,
las compuertas y las revisiones funcionan, pero `task_close` no puede cerrar.
Instala `opencode-memory` o crea tablas compatibles antes de usar el flujo de
cierre.

## Flujo de uso

1. Abre un repositorio con OpenCode. `factory` es el agente por defecto.
2. En la primera sesión, `factory` hace onboarding: detecta stack, verifica
   comandos, guarda el perfil y ejecuta un baseline de compuertas.
3. Para una tarea:
   - `task_create` con criterios verificables.
   - `git_branch` para crear `factory/<slug>`.
   - Implementa el cambio.
   - `run_gates` en modo `check` con `task_id` e `iteration`.
   - Corrige bloqueantes y repite.
   - Pasa `@code-reviewer` y `@qa-engineer`, y `@security-reviewer` si el diff
     toca superficie sensible. Cada revisor llama a `review_submit`.
   - `git_commit` en rama no protegida.
   - Guarda memoria y cierra con `task_close`.
4. `task_close` calcula si aplica seguridad desde el diff. Si el diff toca SQL,
   entradas, auth, archivos, red, secretos o dependencias y decides no pedir
   revisión, debes pasar `security_justification`; queda guardada.
5. El push y el deploy no son automáticos. La fábrica commitea en local; el
   push lo decides tú.

## Modo por fases

Para proyectos existentes con un documento de fases, la fábrica puede planificar
antes de tocar código y repartir el trabajo en subagentes paralelos. La guía
completa está en `docs/orchestration.md`; este es el resumen:

1. **Ingesta** (`factory-intake`): lee documentos y código, ejecuta baseline de
   compuertas, evalúa la postura de seguridad y propone un diff de fases. No
   cambia el alcance sin aprobación.
2. **Plan** (`plan_create`): fases → tareas con dependencias, dificultad,
   `files_owned`, criterios de aceptación y modelo.
3. **Revisión y validación** (`plan_review`, `plan_validate`): un
   `plan-reviewer` de familia distinta revisa el plan. Dos rondas normales;
   `CRÍTICO`/`ALTO` bloquean, `MEDIO`/`BAJO` son deuda con `confirmed=true`.
   Si se agota la revisión, `plan_review` devuelve `exhausted` con las opciones
   `approve_with_waiver`, `fix_and_revalidate` o `cancel`; una tercera ronda
   exige `confirmed=true`. La validación determinista comprueba ciclos,
   archivos, solapamientos y tareas sensibles.
4. **Aprobación humana**: `plan_update` con `status=approved` y
   `confirmed=true`. No se omite.
5. **Ejecución** (`subtask_run`): una sesión `implementer` y un `git worktree`
   por tarea, en `~/.local/share/opencode/worktrees/<proyecto>/`. El
   implementer solo edita `files_owned`; el diff se valida y el commit lo hace
   la tool de forma controlada. Los subagentes nativos no heredan tools de
   edición, así que la ejecución paralela real usa `subtask_run` con worktrees,
   no el tool `subagent` directo.
6. **Compuertas y revisión** (`run_gates` con `worktree`, `review_run`):
   code/security/qa con modelos de familia distinta al autor.
7. **Integración** (`subtask_integrate`): solo en
   `factory/integration/<proyecto>`; nunca en `main`, `master` ni `develop`.
8. **Cierre de fase** (`phase_close`): exige tareas integradas, gate verde en la
   rama de integración, revisiones aprobadas, memoria e informe de coste/tiempo.
   En autonomía `supervised` exige `confirmed=true`.
9. **Reanudación** (`plan_resume`, `factory_doctor`): reconcilia sesiones y
   worktrees, detecta huérfanos y tareas colgadas.

Autonomía por defecto: `supervised`. La concurrencia por defecto es 3 y se
configura por plan. El estado vive en PostgreSQL (migraciones 004 y 005), así
que una sesión interrumpida no pierde el plan. Los worktrees viven fuera de
`/tmp`, en `~/.local/share/opencode/worktrees/<proyecto>/`.

## Modelos por rol y cómo cambiarlos

| Agente | Rol | Modelo por defecto |
|---|---|---|
| `factory` | Orquestador y programador | `opencode-go/deepseek-v4.1-flash` |
| `security-reviewer` | Revisión de seguridad | `opencode-go/glm-5.3-flash` |
| `code-reviewer` | Diseño, errores y mantenibilidad | `opencode-go/claude-haiku-5-5` |
| `qa-engineer` | QA adversarial y tests | `opencode-go/minimax-m3` |
| `helper` | Segunda opinión y documentación | `opencode-go/glm-5.3-flash` |
| `researcher` | Información cambiante fuera de docs | `opencode-go/deepseek-v4.1-flash` |
| `plan-reviewer` | Revisión del plan por fases (solo lectura) | `opencode-go/claude-haiku-5-5` |
| `implementer` | Tarea pequeña aislada en su worktree | `opencode-go/glm-5.3-flash` |

En el modo por fases, `subtask_run` puede fijar otro modelo por tarea y
`review_run`/`phase_close` eligen el revisor por familia: un revisor nunca usa
la misma familia que el autor. El ruteo vive en `tools/factory/routing.ts`.
Kimi K2.7 no está en el ruteo normal; solo se usa como escalado manual para bugs
o arquitectura compleja.

Para cambiar un modelo, edita `model:` en el frontmatter del agente:

```yaml
---
description: Revisor de seguridad...
mode: subagent
model: tu-proveedor/tu-modelo
---
```

`factory_doctor` compara los modelos con `EXPECTED_AGENTS` en
`tools/factory/doctor.ts`. Si cambias un modelo y no actualizas esa lista,
verás un `warn` (no un error). Actualízala o acepta el aviso.

Los modelos deben existir en tu configuración de OpenCode. Los revisores son de
solo lectura y solo tienen permiso para `read` y `review_submit`; el orquestador
tiene `review_submit` denegado. En el modo por fases, `implementer` solo puede
leer y editar dentro de su worktree: no tiene shell, no lanza subagentes y no
puede commitear; `subtask_run` hace el commit controlado y rechaza cualquier
archivo fuera de `files_owned`.

## Qué ejecuta y qué permisos usa

| Tool | Qué ejecuta | Permiso / efecto |
|---|---|---|
| `project_detect` | Comandos de versión y lectura de manifiestos. | Sin escritura. |
| `run_checks` | `install`, `lint`, `typecheck`, `test`, `build` del perfil. | `shell`; pide permiso y aplica timeout. |
| `run_gates` | Las mismas compuertas más cobertura, seguridad, dependencias, etc. | `shell`; registra evidencia en `gate_runs`. |
| `security_scan` | `semgrep`, `gitleaks`, `osv-scanner`, `trivy`. | `shell`; offline por defecto; online solo si se pide. |
| `git_branch` | `git switch` / `git switch -c`. | `shell`; rechaza ramas protegidas. |
| `git_commit` | `git add` y `git commit`. | Acción `git.commit`; solo rama no protegida; sin push. |
| `review_submit` | Escritura en `review_runs`. | Solo revisores; el orquestador no puede. |
| `task_close` | Lectura git, escritura en `tasks` y `closure_report`. | Sin push; exige gates, revisiones, memoria y evidencia. |
| `plan_create`, `plan_update`, `plan_status` | Plan por fases en PostgreSQL. | Sin shell; valida el grafo antes de insertar. |
| `plan_validate`, `plan_review` | Validación determinista y revisión del plan por severidad. | `plan_review` lanza un subagente de solo lectura; `exhausted` pide decisión humana. |
| `plan_update` | Aprueba con deuda o waiver, corrige/revalida o cancela. | `confirmed=true`; `CRÍTICO` no se puede waivear. |
| `subtask_run` | Crea worktree en `~/.local/share/opencode/worktrees/<proyecto>/`, rama y sesión `implementer`. | `git.worktree`; valida el diff contra `files_owned`. |
| `review_run` | Lanza revisores y exige `review_submit`. | Sesiones de solo lectura; modelos de otra familia. |
| `subtask_integrate` | `git merge --no-ff` en la rama de integración. | Solo `factory/integration/<proyecto>`; aborta conflictos. |
| `phase_close`, `plan_resume` | Cierre de fase y reconciliación de sesiones/worktrees. | `phase_close` exige gate, revisiones, memoria y `confirmed` en `supervised`. |
| `factory_doctor` | `--version` de escáneres, consultas a PostgreSQL y worktrees. | Sin escritura. |
| `memory_*` | PostgreSQL + Ollama, si `opencode-memory` está instalado. | Fuera de este repo. |

Detalles:

- **Shell:** las tools que ejecutan comandos llaman a `ctx.permission.assert`
  antes de lanzarlos. Los comandos quedan en la evidencia de la compuerta.
- **Git:** la fábrica lee rama, diff, estado y archivos. `git_commit` es el único
  camino para stagear/commitear y no funciona en `main`, `master`, `develop` ni
  en las ramas protegidas del perfil. No hace push, deploy ni operaciones
  destructivas.
- **Escáneres:** no se instalan solos. Si faltan, la compuerta lo reporta como
  `missing`, `skipped` o `error`; nunca como `pass`.
- **Red:** el modo `offline` no consulta red (Semgrep con `--metrics=off`,
  Gitleaks local, OSV offline, Trivy sin actualizar DB). El modo `online` sí
  consulta la red y lo declara. `npm ci` y el script de packs también usan red.
- **Archivos:** las tools leen el proyecto; las compuertas pueden escribir si el
  comando del perfil lo hace. `git_commit` valida que las rutas estén dentro del
  repo. Los informes se guardan en PostgreSQL.

## Compuertas

`run_gates` ejecuta, en orden de coste: `format`, `lint`, `typecheck`, `build`,
`test`, `coverage`, `security`, `dependencies`, `static`, `e2e`, `accessibility`,
`api`, `migrations` y, solo bajo petición, `mutation`/`performance`.

- `pass | fail | skipped | error`; un `skipped` siempre lleva razón y no cuenta
  como `pass`.
- `baseline` en onboarding; solo los hallazgos nuevos bloquean. La deuda previa
  se reporta aparte.
- Política por defecto: `build`, `lint`, `typecheck`, `test`, secretos y
  vulnerabilidades críticas/altas bloquean; cobertura avisa. Se puede cambiar
  por proyecto con `quality_policy_set` y confirmación explícita.
- PHP sin Xdebug/PCOV: cobertura `skipped` con razón.
- Si un escáner falla, la compuerta de seguridad es `error`, no `pass`.

## Informe de cierre, tokens y coste

`task_close` guarda en `tasks.closure_report`:

- compuertas con estado, evidencia y razón de skip;
- criterios de aceptación con evidencia;
- revisiones con modelo, veredicto y bloqueantes;
- aplicabilidad de seguridad calculada del diff y justificación si la hay;
- memoria, riesgos residuales y waivers;
- uso de tokens y coste por modelo.

El uso sale de la sesión de OpenCode. Si el proveedor reporta coste > 0 se usa
tal cual; si no, se estima con el catálogo de modelos en USD por millón de
tokens. El coste del orquestador es acumulado y puede incluir otras tareas. No
es una factura. La fórmula está en `plugins/factory/README.md`.

## Limitaciones conocidas

- **Variabilidad de los revisores.** El mismo benchmark y el mismo prompt pueden
  dar resultados distintos entre ejecuciones. En el benchmark externo de 8
  módulos, GLM dio 6/8 en una pasada y 8/8 en otra; Kimi 7/8 y GPT 4/8 + una
  sospecha. No son resultados deterministas.
- **Benchmark pequeño.** Ocho módulos, un solo repo y pocas ejecuciones por
  modelo, sin repetición sistemática. Sirve para comparar tendencias, no como
  estudio estadístico.
- **E2E, accesibilidad y migraciones** están implementadas pero no se han
  probado a fondo en proyectos reales. Sin comando configurado quedan
  `skipped`; no equivalen a una validación completa.
- **Cobertura PHP** sin Xdebug/PCOV queda `skipped` con razón. El resto de
  compuertas sigue funcionando; la cobertura no se inventa.
- **Seguridad desde el diff** es heurística: puede marcar de más (falso
  positivo) o de menos (falso negativo). Si el diff toca superficie sensible y
  se omite la revisión, queda una justificación guardada, pero la decisión
  sigue siendo humana.
- **Coste estimado:** precios de catálogo, sin descuentos horarios ni
  promociones; los tokens de razonamiento se facturan a precio de salida.
- **`opencode-memory` no incluido:** sin ese plugin no existen las tools de
  memoria. `factory_doctor` avisa (dos tablas y el plugin) y `task_close` no
  puede cerrar; las compuertas y revisiones sí funcionan. Instálalo aparte o
  adapta el cierre.
- **Modo por fases validado en un proyecto sintético**, no en proyectos reales
  grandes: dos tareas paralelas, gates, revisiones, integración y cierre de fase.
  Los casos de edición fuera de `files_owned`, doble fallo del implementer,
  ciclos de dependencias y sesión interrumpida están cubiertos por la validación
  determinista y `plan_resume`, pero no sustituyen una prueba de campo.
- **Plan reviewer con dos rondas normales.** Si no converge, `plan_review`
  devuelve `exhausted` y el usuario decide (`approve_with_waiver`,
  `fix_and_revalidate` o `cancel`); una tercera ronda exige `confirmed=true`.
- **Worktrees en disco.** Cada tarea crea un `git worktree` en
  `~/.local/share/opencode/worktrees/<proyecto>/`; si se interrumpe,
  `plan_resume` y `factory_doctor` detectan worktrees huérfanos, ausentes o con
  `.git` roto, pero la limpieza final es manual.
- **Coste por fase estimado.** `phase_close` agrega tokens y coste de las
  sesiones registradas; si el proveedor no reporta precio, la cifra es una
  estimación de catálogo, no una factura.
- **Probado en Linux** (CachyOS/Arch). No se ha validado en macOS ni Windows.
- **El push no es automático.** La fábrica commitea en local; publicar es una
  decisión explícita.

## Desinstalación

La fábrica base y el modo por fases se desinstalan restaurando el backup previo
y, solo si no necesitas los datos, revirtiendo las migraciones 005 y 004 en ese
orden. Los pasos completos —incluido el SQL de reversión, las columnas nuevas y
la limpieza de worktrees— están en `docs/orchestration.md` §8 y en
`plugins/factory/README.md`.

## Seguridad y datos

- No se versionan `secrets/`, `service.json`, `.env`, claves, backups,
  `node_modules`, packs de Semgrep ni `plugins/opencode-memory/`.
- `opencode.json` es local y está en `.gitignore`; la plantilla versionada es
  `opencode.example.json`.
- Antes de publicar se ejecuta `gitleaks` sobre el historial completo y sobre el
  árbol exacto. Los resultados están en `SECURITY.md`.
- Si haces público el repo, revisa las rutas locales y rota cualquier credencial
  que hayas usado en pruebas.

## Atribuciones

Ver `THIRD-PARTY.md`. No se redistribuyen packs de Semgrep (Semgrep Rules
License v1.0) ni plugins de terceros sin licencia clara.

## Licencia

MIT. Copyright (c) 2026 Dinosurus. Ver `LICENSE`.
