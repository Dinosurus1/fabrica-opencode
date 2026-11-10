---
name: Factory Phase Orchestration
description: Flujo completo del modo por fases: plan, revisión, validación, ejecución paralela en worktrees, integración, cierre y reanudación.
metadata:
  opencode/autoinvoke: false
---
# Orquestación por fases

Objetivo: ejecutar un plan aprobado sin perder el control del alcance, del
trabajo paralelo ni de la evidencia. El estado vive en PostgreSQL; no dependas
de la memoria de la conversación.

## 0. Antes de empezar

- El proyecto tiene perfil verificado (`project_profile_set` con `verified: true`)
  y baseline ejecutado. Si no, vuelve a `factory-onboarding`.
- El alcance está aprobado por el usuario. Si no, usa `factory-intake` y espera.
- Autonomía por defecto: `supervised`. `autonomous` exige `confirmed=true` al
  crear el plan y no autoriza push, deploy ni merges a ramas protegidas.

## 1. Crear el plan

`plan_create` con:

- `title`, `autonomy`, `max_concurrency` (default 3, máximo 8);
- `source_documents` y `metadata`;
- tareas con `key`, `phase`, `title`, `description`, `acceptance_criteria`,
  `difficulty`, `assignee`, `files_owned`, `depends_on`, `risk_flags`,
  `parallelizable` y, si aplica, `model`.

El grafo se valida antes de insertar. Si falla, corrige el plan; no lo fuerces.

## 2. Revisar y validar

```text
plan_review({ plan_id })
plan_validate({ plan_id })
```

- `plan_review` lanza `plan-reviewer` (familia distinta al orquestador). Máximo
  2 rondas; `plans.review_round` no pasa de 2.
- Cada hallazgo se registra en `plan_update.review_decisions` con
  `decision: "accepted" | "refuted"` y `evidence`.
- Un hallazgo `accepted` obliga a corregir, revalidar y, si aplica, revisar de
  nuevo. Un `refuted` sin evidencia no cuenta.
- `plan_validate` es determinista: ciclos, criterios, archivos, solapamientos y
  tareas fáciles sobre superficie sensible.

No apruebes el plan con errores de validación ni con hallazgos aceptados sin
resolver.

## 3. Aprobar

```text
plan_update({ plan_id, status: "approved", confirmed: true })
```

La aprobación es humana. En `supervised`, cada cierre de fase también requiere
`confirmed=true`.

## 4. Elegir la ola

```text
plan_status({ plan_id })
```

Lee `next_wave`, `deferred` y `blocked`. La ola respeta:

- dependencias `done`/`merged`;
- `max_concurrency`;
- archivos solapados (no van en la misma ola);
- tareas `parallelizable: false` (se serializan);
- tareas activas (`running`/`review`).

No lances tareas `assignee: "orchestrator"` con `subtask_run`; las hace el
orquestador.

## 5. Ejecutar

```text
subtask_run({ plan_id, task_ids: [...], timeout_minutes: 20 })
```

Por tarea:

1. crea o reutiliza un `git worktree` con rama `factory/...`;
2. abre una sesión `implementer` con `edit` limitado `${worktree}/**`;
3. espera con timeout;
4. valida el diff real contra `files_owned`;
5. hace un commit controlado si quedan cambios;
6. deja la tarea en `review` o la marca `failed`.

Si el worktree queda sucio tras el commit, falla. Si el diff toca fuera de
`files_owned`, falla aunque el commit exista. Dos fallos → `escalated`; la hace
el orquestador.

## 6. Compuertas y revisión

```text
run_gates({ task_id, iteration: 1, worktree: "/ruta/worktree" })
review_run({ plan_id, task_id, gate_run_id, roles: ["code", "qa"], iteration: 1 })
```

- `run_gates` con `worktree` comprueba que pertenece al proyecto o está
  registrado en un plan. Un `skipped` no es `pass`.
- `review_run` elige modelos de familia distinta al autor y espera a que cada
  revisor llame a `review_submit`.
- Tareas sensibles: `security`, `code`, `qa`. No sensibles: `code`, `qa`.
- Si un revisor no llama a `review_submit`, la revisión no existe. No lo
  sustituyas por texto libre.
- Máximo 3 iteraciones por tarea. Corrige la causa raíz y vuelve a ejecutar las
  compuertas afectadas.

## 7. Integrar

```text
subtask_integrate({ plan_id, task_id })
```

Exige tarea en `review`, gate en verde y revisiones aprobadas. Valida otra vez
`files_owned`, comprueba que el worktree esté limpio y fusiona con `--no-ff` en
`factory/integration/<proyecto>`. Nunca en `main`, `master` ni `develop`.

Si hay conflicto, la tool aborta y devuelve los archivos. Resuélvelo en el
orquestador o pide una tarea de integración; no inventes una resolución dentro
de la tool.

## 8. Cerrar la fase

```text
run_gates({ gates: ["test", "security"] })   # en la rama de integración
phase_close({
  plan_id,
  phase,
  gate_run_id,
  memory_id,
  residual_risks,
  confirmed: true,
  timeout_minutes: 20
})
```

`phase_close` exige:

- todas las tareas de la fase en `merged`/`done`;
- gate `pass` en `factory/integration/<proyecto>`;
- revisiones code/qa aprobadas y security si la fase es sensible;
- `open_blocking: 0`;
- memoria existente y del proyecto (o global);
- `confirmed=true` en autonomía `supervised`;
- que la fase no tenga cierre previo.

El informe guarda gate, revisiones, riesgos residuales, tokens, coste por modelo,
tiempo, tareas delegadas y escaladas. Si la revisión pide cambios, la fase **no**
se cierra: corrige, repite el gate y vuelve a llamar.

## 9. Reanudar

```text
plan_resume({ plan_id })
factory_doctor()
```

`plan_resume` revisa tareas `running`/`review`, sesiones y worktrees:

- worktree ausente → `failed`;
- sesión `failed`/`interrupted` → `failed` o `escalated` según intentos;
- sin `session_id` → `retryable`;
- worktree no registrado por git → aviso.

`factory_doctor` detecta worktrees huérfanos, worktrees del plan que ya no
existen y tareas colgadas >90 min. Limpia worktrees y ramas a mano tras
integrar; no borres `memories` ni `capture_state`.

## 10. Paradas obligatorias

Detente y pide decisión humana si:

- el plan cambia de alcance;
- una tarea sensible queda sin revisión de seguridad;
- hay un ciclo o un solapamiento que no se puede resolver;
- el implementer falla dos veces y la tarea escala;
- el gate de integración no queda verde;
- hay un conflicto de merge;
- el coste o el tiempo se salen del presupuesto acordado;
- `factory_doctor` reporta un error de esquema o de datos.

## 11. Informe final

Distingue siempre **verificado** de **esperado**:

- fases cerradas y tareas integradas;
- gates con estado y evidencia;
- revisiones con modelo, veredicto y bloqueantes;
- worktrees/ramas creados y limpiados;
- coste y tiempo reales frente a lo estimado;
- riesgos residuales y lo que no se pudo verificar.
