# Orquestación por fases

> **Versión:** 1.0.0 · **Fecha:** 2026-11-09 · **Estado:** Implementado; validación sintética en curso (fase 0 completada).
> **Alcance:** modo de trabajo por fases sobre OpenCode V2: ingesta, plan, revisión, validación, ejecución paralela en worktrees, integración, cierre y reanudación.

## 1. Qué añade

La fábrica original construye y verifica tareas una por una. Este modo añade:

- **Ingesta de proyecto existente**: documentos de fases, código, baseline y postura de seguridad.
- **Plan en PostgreSQL**: fases, tareas, dependencias, dificultad, archivos, modelos y aceptación.
- **Plan reviewer**: subagente de solo lectura que revisa el plan antes de ejecutarlo.
- **Validación determinista**: ciclos, criterios, archivos, solapamientos y superficies sensibles.
- **Ejecución paralela**: un `git worktree` y una sesión `implementer` por tarea, sin pisarse.
- **Revisión por familia distinta**: el revisor de una tarea nunca usa la familia del autor.
- **Integración controlada**: solo en `factory/integration/<proyecto>`, nunca en main/master/develop.
- **Cierre de fase**: gates, revisiones, memoria, informe y coste/tiempo.
- **Reanudación**: el estado vive en PostgreSQL; `plan_resume` reconcilia sesiones y worktrees.

## 2. Modelos y ruteo

| Rol | Modelo por defecto |
|---|---|
| Orquestador / código difícil o sensible | `opencode-go/deepseek-v4.1-flash` |
| Implementer fácil | `opencode-go/glm-5.3-flash` |
| Implementer mecánico / QA simple | `opencode-go/gpt-6-luna` (cuando se asigna explícitamente) |
| Plan reviewer | `opencode-go/claude-haiku-5-5` |
| Seguridad | `opencode-go/glm-5.3-flash`; si el autor es GLM, `opencode-go/deepseek-v4.1-flash` |
| Código | `opencode-go/claude-haiku-5-5`; si el autor es Claude, `opencode-go/deepseek-v4.1-flash` |
| QA | `opencode-go/minimax-m3`; `gpt-6-luna` para tareas simples |
| Kimi K2.7 Code | Solo escalado manual para bugs/arquitectura compleja |

La regla vive en `tools/factory/routing.ts`. Los prompts no hardcodean modelos. Para cambiarla, edita `MODELS` y/o `routeReview`; para cambiar el modelo base de un agente, edita su frontmatter.

## 3. Autonomía

| Nivel | Comportamiento |
|---|---|
| `supervised` (default) | El usuario aprueba el plan y cada cierre de fase. |
| `semi_autonomous` | El usuario aprueba el plan; la fábrica cierra fases si todo está verde y sin hallazgos abiertos. |
| `autonomous` | Ejecuta todo y se detiene solo ante bloqueos o fallos. Requiere confirmación explícita. |

En cualquier nivel requieren confirmación humana: cambios de alcance, `git push`, merges a ramas protegidas, instalación de software y comandos destructivos.

## 4. Flujo

### 4.1 Ingesta

Carga `factory-intake` o pide:

```text
Haz intake de este repo y de docs/fases.md. Ejecuta baseline de compuertas,
evalúa la postura de seguridad y propón un plan por fases. No cambies alcance.
```

Salida esperada:

- Stack, comandos verificados y baseline.
- Riesgos de seguridad y propuesta de pista de hardening.
- Diff propuesto sobre el documento de fases (nunca aplicado sin aprobación).
- Borrador de plan.

### 4.2 Crear el plan

```text
plan_create({
  title: "Proyecto X",
  autonomy: "supervised",
  max_concurrency: 3,
  source_documents: ["docs/fases.md"],
  tasks: [
    { key: "t1", phase: 0, title: "...", description: "...",
      acceptance_criteria: "...", difficulty: "easy",
      assignee: "implementer", files_owned: ["src/a.ts"],
      depends_on: [] }
  ]
})
```

`plan_create` valida el grafo antes de insertar. Si falla, no crea el plan.
El triaje de dificultad, sensibilidad, archivos y modelo sigue la skill
`factory-task-triage`; ante la duda, la tarea sube de dificultad y va al
orquestador.

### 4.3 Revisar y validar

```text
plan_review({ plan_id })
plan_validate({ plan_id })
```

- `plan_review` lanza `plan-reviewer` (Claude Haiku) con el plan, documentos y proyecto. Dos rondas normales; una tercera exige `confirmed=true` tras `exhausted`.
- Cada hallazgo se acepta o refuta con evidencia en `plan_update.review_decisions`.
- Un hallazgo `accepted` invalida la validación y obliga a corregir, revalidar y volver a revisar.
- `plan_validate` es determinista y no usa LLM.

### 4.4 Aprobar

```text
plan_update({ plan_id, status: "approved", confirmed: true })
```

Requiere validación en verde y al menos una revisión de plan. En autonomía total, `confirmed=true` también es obligatorio al crear el plan.

### 4.5 Ejecutar una ola

```text
plan_status({ plan_id })       # ver next_wave
subtask_run({ plan_id, task_ids: ["...","..."], timeout_minutes: 20 })
```

- `subtask_run` solo acepta tareas `assignee=implementer` y estados `pending`/`ready` (o `failed` con menos de 2 intentos).
- Crea un worktree por tarea en `~/.local/share/opencode/worktrees/<proyecto>/`
  con `git worktree add`, una rama `factory/...` y una sesión `implementer`.
- El implementer no tiene shell ni `git_commit`; `subtask_run` hace un commit controlado si quedan cambios sin commit.
- El diff se valida contra `files_owned`; si toca fuera, la tarea falla y no se integra.
- Si falla dos veces, la tarea pasa a `escalated` y la hace el orquestador.

### 4.6 Compuertas y revisión

```text
run_gates({ task_id, iteration: 1, worktree: "/ruta/worktree" })
review_run({ plan_id, task_id, gate_run_id, roles: ["code","qa"], iteration: 1 })
```

- `run_gates` con `worktree` valida que el worktree pertenezca al proyecto o esté registrado en un plan.
- `review_run` elige modelos de familia distinta al autor y exige que cada revisor llame a `review_submit`.
- Para tareas sensibles, incluye `security`; para tareas no sensibles, code+qa.

### 4.7 Integrar

```text
subtask_integrate({ plan_id, task_id })
```

- Exige tarea en `review`, gate en verde y revisiones aprobadas.
- Valida que la rama no toque archivos fuera de `files_owned`.
- Fusiona en `factory/integration/<proyecto>` con `--no-ff`.
- Nunca fusiona en main/master/develop. Si hay conflicto, aborta y devuelve los archivos.

### 4.8 Cerrar la fase

```text
run_gates({ gates: ["test","security"] })   # sobre la rama de integración
phase_close({
  plan_id, phase: 0,
  gate_run_id,
  memory_id,
  residual_risks: "ninguno",
  confirmed: true
})
```

`phase_close`:

- Exige todas las tareas de la fase en `merged`/`done`.
- Exige gate verde en `factory/integration/<proyecto>`.
- Lanza code/qa (y security si la fase es sensible) sobre el diff acumulado.
  El prompt incluye los criterios de aceptación de las tareas y aclara que el
  gate ejecuta la suite completa del repo, no solo el diff de la fase.
- Exige memoria e informe con tokens, coste por modelo, tiempo, tareas delegadas y escaladas.
- En autonomía supervisada exige `confirmed=true`.

### 4.9 Reanudar

```text
plan_resume({ plan_id })
factory_doctor()
```

`plan_resume` revisa tareas `running`/`review`, sesiones y worktrees; marca fallos y deja acciones. `factory_doctor` detecta worktrees huérfanos, worktrees del plan que ya no existen y tareas colgadas >90 min.

## 5. Esquema de datos

Migraciones: `004_orchestration.sql` y `005_review_severity.sql`
(`schema_version=5`).

| Tabla | Uso |
|---|---|
| `plans` | Plan, autonomía, concurrencia, rondas, validación, `review_exhausted`, `residual_findings` y `approval_waiver`. |
| `plan_tasks` | Tareas, fase, dificultad, assignee, modelo, archivos, dependencias, worktree, rama, estado, resultado. |
| `plan_reviews` | Veredictos por ronda, bloqueantes/advisorios y métricas `new_findings`/`resolved_findings`. |
| `plan_validations` | Historial de validaciones deterministas. |
| `subtask_runs` | Cada intento de implementer: sesión, worktree, coste, tokens, resultado. |
| `phase_closures` | Cierre de fase con gate, revisiones, informe, exenciones y coste. |
| `tasks.author_model` | Modelo autor para ruteo de revisores. |

`plans.review_round` permite 0-2 rondas normales y una tercera solo con
`confirmed=true` tras `exhausted`. `phase_closures` es único por `(plan_id,
phase)`.

## 6. Worktrees y archivos

- Un worktree por tarea en `~/.local/share/opencode/worktrees/<proyecto>/`,
  creado con `git worktree add` desde la rama base y registrado en el plan.
- Rama de tarea: `factory/<plan>-<slug>`.
- Los subagentes nativos (`subagent`) no heredan tools de edición; por eso el
  paralelismo real se hace con `subtask_run` y worktrees, no con `subagent`
  directo.
- `files_owned` son globs; se comparan con el diff real. Cualquier archivo fuera se rechaza.
- Archivos compartidos (lockfiles, configuración, migraciones, rutas centrales) se serializan con `parallelizable=false`; `plan_validate` falla si se marcan paralelos.
- El implementer tiene `edit` solo dentro de su worktree; `shell` y `subagent` denegados.
- El commit es controlado por `subtask_run` si el implementer no commitea (no tiene `git_commit` en su catálogo).

## 7. Coste y tiempo

Cada `subtask_runs` guarda tokens/coste de la sesión. `phase_close` agrega:

- tokens de entrada/salida/razonamiento/caché;
- coste por modelo;
- tiempo desde el primer `started_at` hasta el último `finished_at`;
- tareas delegadas y escaladas.

El coste es una estimación cuando el proveedor no lo reporta. La fórmula está en `plugins/factory/README.md`. El plan review se contabiliza aparte en `plan_reviews`.

## 8. Desinstalación

### 8.1 Restaurar archivos

1. Detén OpenCode.
2. Restaura el backup previo:

```bash
cd ~/.config/opencode
rm -rf agents tools/factory plugins/factory skills README.md SECURITY.md
cp -a backups/orchestration-<fecha>/agents ./agents
cp -a backups/orchestration-<fecha>/tools/factory ./tools/factory
cp -a backups/orchestration-<fecha>/plugins/factory ./plugins/factory
cp -a backups/orchestration-<fecha>/skills ./skills
cp backups/orchestration-<fecha>/README.md ./README.md
cp backups/orchestration-<fecha>/SECURITY.md ./SECURITY.md
```

3. Reinstala dependencias si hace falta: `cd plugins/factory && npm ci`.
4. Reinicia OpenCode.

### 8.2 Revertir la migración 005

Solo si no necesitas los datos de revisión. Haz backup de la base primero.

```sql
BEGIN;
ALTER TABLE plans
  DROP COLUMN IF EXISTS review_exhausted,
  DROP COLUMN IF EXISTS residual_findings,
  DROP COLUMN IF EXISTS approval_waiver;
ALTER TABLE plan_reviews
  DROP COLUMN IF EXISTS blocking_count,
  DROP COLUMN IF EXISTS advisory_count,
  DROP COLUMN IF EXISTS new_findings,
  DROP COLUMN IF EXISTS resolved_findings;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_review_round_check;
ALTER TABLE plans ADD CONSTRAINT plans_review_round_check CHECK (review_round BETWEEN 0 AND 2);
ALTER TABLE plan_reviews DROP CONSTRAINT IF EXISTS plan_reviews_round_check;
ALTER TABLE plan_reviews ADD CONSTRAINT plan_reviews_round_check CHECK (round BETWEEN 1 AND 2);
UPDATE factory_meta SET value = '4'::jsonb, updated_at = now()
WHERE key = 'schema_version';
COMMIT;
```

### 8.3 Revertir la migración 004

Solo si no necesitas los datos de plan. Haz backup de la base primero.

```sql
BEGIN;
DROP TABLE IF EXISTS phase_closures;
DROP TABLE IF EXISTS subtask_runs;
DROP TABLE IF EXISTS plan_validations;
DROP TABLE IF EXISTS plan_reviews;
DROP TABLE IF EXISTS plan_tasks;
DROP TABLE IF EXISTS plans;
ALTER TABLE tasks DROP COLUMN IF EXISTS author_model;
ALTER TABLE factory_projects
  DROP COLUMN IF EXISTS autonomy,
  DROP COLUMN IF EXISTS max_concurrency;
UPDATE factory_meta SET value = '3'::jsonb, updated_at = now()
WHERE key = 'schema_version';
COMMIT;
```

5. `factory_doctor` debe volver a `schema_version=3` tras revertir 004.
6. No borres `memories` ni `capture_state`.

## 9. Limitaciones conocidas

- **Implementer sin `git_commit`:** el subagente no tiene esa tool; el commit lo hace `subtask_run` de forma controlada. Si cambias el catálogo del subagente, revisa esta decisión.
- **Revisores y worktree:** el diff y las rutas absolutas se pasan en el prompt; si un revisor no puede leer el worktree, debe basarse en el diff y el gate, y decirlo.
- **Plan reviewer:** dos rondas normales. `CRÍTICO`/`ALTO` bloquean; `MEDIO`/`BAJO` son deuda con `confirmed=true`. Un `CRÍTICO` no se puede refutar ni waivear: solo lo cierra una ronda posterior aprobada que ya no lo reporte. Si se agota, `plan_review` devuelve `exhausted` y el usuario decide (`approve_with_waiver`, `fix_and_revalidate` o `cancel`); una tercera ronda exige `confirmed=true`.
- **Autonomía total:** no se activa sin `confirmed=true`; no hay push automático.
- **Integración:** los conflictos los resuelve el orquestador; la herramienta aborta y no inventa resoluciones.
- **Coste:** estimación de catálogo; no es factura.
- **Validación:** el proyecto sintético cubre casos básicos; los casos de fallo doble y edición fuera de alcance se validan en la Etapa D.
