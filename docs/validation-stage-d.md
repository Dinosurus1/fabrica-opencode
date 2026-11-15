# Validación Etapa D

Fecha: 2026-11-09/10. Proyecto sintético:
`/tmp/opencode/fabrica-v2-synth` (Node.js, CommonJS, `master`).
Alcance: casos de borde del modo por fases. No es una prueba de producto real.

## 1. Proyecto de 6 fases

Se crearon dos planes de 6 fases:

| Plan | ID | Estado | Resultado |
|---|---|---|---|
| 6 fases inicial | `becbc233-ce7d-45c9-9b49-7ece37ffb515` | `review_pending` | Ronda 1: 14 hallazgos (3 refutados, 11 aceptados). Ronda 2: más hallazgos; máximo de 2 rondas alcanzado. No aprobado. |
| 6 fases corregido | `6af200be-7c91-4757-a394-166bcb1db8bd` | `review_pending` | Ronda 1: 11 hallazgos. Ronda 2: 12 hallazgos. Máximo alcanzado. No aprobado. |

Fases definidas: 0 base, 1 formato, 2 robustez/documentación, 3 integración,
4 seguridad y 5 cierre. Tareas: `src/validation.js`, `src/numbers.js`,
`src/format.js`, `src/index.js`, `docs/validation.md`, `SECURITY.md`,
`CHANGELOG.md` y sus tests.

**No se ejecutaron las tareas del plan de 6 fases**: el plan-reviewer no lo
aprobó en 2 rondas. El plan quedó como evidencia del límite de revisión.

## 2. Casos deterministas

Se usó un plan inválido con seis tareas para provocar varios errores a la vez.
`plan_create` devolvió `created: false` y **no insertó el plan**.

| Caso | Esperado | Real | Evidencia |
|---|---|---|---|
| Ciclo de dependencias | `plan.cycle` | Sí | `Ciclo A → Ciclo B → Ciclo A` |
| Solape de archivos en paralelo | `plan.files_overlap` | Sí | `Solape A` y `Solape B` comparten `src/shared.js` |
| Tarea sensible delegada a implementer | `task.easy_sensitive_delegated` | Sí | `Auth fácil` con `risk_flags: ["auth"]` |
| Archivo compartido paralelo | `task.shared_parallel` | Sí | `package.json` con `parallelizable: true` |
| Plan inválido no se persiste | `created: false` | Sí | No se creó fila en `plans` |

## 3. Plan-reviewer: hallazgo refutado

En el plan `becbc233...` se registraron 14 decisiones en
`plan_update.review_decisions`:

- **11 aceptadas**: dependencias, criterios verificables, alcance de seguridad,
  numeración de fases y clasificación.
- **3 refutadas con evidencia**:
  1. `sourceDocuments` insuficiente: el encargo de Etapa D es la definición del
     proyecto sintético; no existe un documento de fases previo.
  2. `parallelizable` frente a olas: `plan.validation.waves` es una capa
     topológica; `plan_status.next_wave` aplica concurrencia y serialización
     (`tools/factory/scheduler.ts`).
  3. `reviewRoute` vacío en tarea sensible: se calcula en `subtask_run` para
     implementers y `phase_close` recalcula la sensibilidad de la fase.

El plan se revalidó (`plan_validate` → `ok: true`) y se lanzó la ronda 2. La
ronda 2 volvió a pedir cambios y ya no había tercera ronda. **El plan no se
aprobó**, que es el comportamiento esperado cuando no converge.

## 4. Edición fuera de `files_owned` y doble fallo

Para probar `subtask_run` sin un plan nuevo aprobado se usó como fixture el plan
ya aprobado `5a464271-9140-4661-80fc-30e54873bac0`. Se insertó una tarea de
harness en `plan_tasks`, se creó un worktree desde `master` con
`src/forbidden.js` commiteado fuera de `files_owned`, se ejecutó dos veces y se
eliminó al terminar. No se modificó el código de la fábrica para aprobar nada.

| Intento | Esperado | Real |
|---|---|---|
| 1 | `failed`, `files_outside: ["src/forbidden.js"]` | `failed`; archivos: `src/edge-scope.js`, `src/forbidden.js`, `test/edge-scope.test.js`; `files_outside: ["src/forbidden.js"]` |
| 2 | `escalated`, `attempts: 2` | `escalated`, `attempts: 2`, `lastError: Cambios fuera de files_owned: src/forbidden.js` |

Evidencia:

- worktree: `~/.local/share/opencode/worktree/8a95f2/stage-d-scope`
  (ruta antigua; la convención nueva es
  `~/.local/share/opencode/worktrees/<proyecto>/`)
- rama: `factory/stage-d-scope`
- sesiones: `ses_e3c47f3d1ffevi5JVISzO2gzlX` (intento 1),
  `ses_e3c47a40affeKIHoVRfhLq3QcE` (intento 2)
- coste: US$0,001957 + US$0,001228 = **US$0,003185**
- tiempo: 04:29:41 → 04:30:16 UTC (~35 s)

### Bug encontrado y corregido

La rama de rechazo por `files_owned` devolvía siempre `failed`, incluso en el
segundo intento. Se corrigió `tools/factory/subtasks.ts` para marcar
`escalated` cuando `attempts >= 2`, igual que el resto de fallos. Verificado con
los dos intentos reales.

## 5. Sesión interrumpida

Se puso la tarea de harness en `running` con un `session_id` inexistente y se
llamó a `plan_resume`.

| Esperado | Real |
|---|---|
| Acción `escalated` o `retryable`, estado actualizado | `action: escalated`, `reason: sesión no encontrada`, estado `escalated`, `attempts: 2` |

### Bug encontrado y corregido

`plan_resume` devolvía la lista de tareas anterior a la reconciliación. Se
corrigió `tools/factory/phase.ts` para releer las tareas después de actualizar.
Verificado: la segunda llamada devolvió `status: escalated` en la misma
respuesta.

## 6. Proyecto sin superficie de seguridad

La fase 0 del plan de Etapa B/C se cerró con `sensitive: false` y
`security_applicable: false`; `security_review_id` es `NULL` y solo se exigieron
revisiones `code` y `qa`.

| Campo | Valor |
|---|---|
| `phase_closures.phase` | 0 |
| `report.sensitive` | `false` |
| `report.security_applicable` | `false` |
| `security_review_id` | `NULL` |
| `cost_usd` | US$0,048526 |

Esto confirma que una fase sin auth/SQL/subidas/secretos no exige revisión de
seguridad, pero sí code+qa y gate verde.

## 7. Coste y tiempo

| Concepto | Coste |
|---|---:|
| Plan reviews de Etapa D (5 planes, 8 rondas) | US$0,040205 |
| Subtask runs de Etapa D (2 intentos) | US$0,003185 |
| **Total Etapa D** | **US$0,043390** |
| Cierre de fase 0 de Etapa B/C (referencia) | US$0,048526 |

Tiempo de los dos intentos de subtask: ~35 s. Las rondas de plan-review
consumieron la mayor parte del tiempo de pared; no se registró un `duration`
propio en `plan_reviews`.

## 8. Hallazgos de diseño

1. **Dos rondas normales pueden ser insuficientes con un reviewer estricto.**
   (La tercera ronda con `confirmed=true` se añadió después de esta validación.)
   Dos planes de
   6 fases agotaron las rondas con hallazgos válidos. El flujo correcto es
   detenerse y crear un plan nuevo con las correcciones, no forzar la
   aprobación. Queda documentado como limitación.
2. **Decisiones aceptadas y aprobación.** Si la ronda 2 sigue en
   `changes_required`, las decisiones `accepted` de la ronda 1 bloquean la
   aprobación. Es coherente con “corrige y vuelve a revisar”, pero obliga a un
   plan nuevo cuando ya no quedan rondas.
3. **`plan.validation.waves` no es la ola de ejecución.** Es una capa
   topológica; `plan_status.next_wave` aplica `maxConcurrency` y
   `parallelizable`. Los revisores lo confundieron dos veces; conviene
   renombrar el campo o añadir una nota en la salida.
4. **El harness de ejecución no debe confundirse con el producto.** Se usó el
   plan ya aprobado `5a...` como fixture; en uso normal, cada tarea debe venir
   de un plan aprobado.

## 9. Limpieza

- Se eliminó la tarea de harness, sus `subtask_runs` y el `tasks` vinculado.
- Se eliminó el worktree `stage-d-scope` y la rama `factory/stage-d-scope`
  después de guardar esta evidencia.
- Se eliminaron los planes de Etapa D (`becbc233`, `6af200be`, `a2cddf62`,
  `8baf80ef`). El plan `5a...` se conserva como referencia del cierre de fase y
  quedó en `completed`.
- Estado verificado tras la limpieza: `factory_doctor` → **57 ok, 0 warn, 0
  error**; 2 `plan_tasks` y 6 `subtask_runs` restantes, todos del plan de
  referencia.
- No se borraron `memories` ni `capture_state`.
- `docs/fases.md` y `docs/edge-cases.md` quedan en el proyecto sintético como
  evidencia del alcance.
- El repo reconstruido se clonó en
  `~/.local/share/opencode/fabrica-v2-synth` para que no se pierda al
  limpiar `/tmp`. El plan `5a...` se reasoció al `project_id` del repo
  reconstruido (`b5417229...`) solo para este anexo.

## 11. Anexo Fase 0 · paralelismo nativo vs plan B

El proyecto sintético se reconstruyó en `/tmp/opencode/fabrica-v2-synth` y se
reasoció el plan aprobado `5a464271...` al nuevo `project_id`
(`b5417229...`) para poder ejecutar el anexo. Es una reconstrucción de
laboratorio: el repo original se perdió con `/tmp`.

### 11.1 Paralelismo nativo (subagentes)

Se lanzaron dos subagentes `implementer` en paralelo con el tool nativo
`subagent`, sin worktree:

| Sesión | Creada | Última actividad | Resultado |
|---|---|---|---|
| `ses_e39a00fc1ffeETnHpA1gNg1J0G` | 1794329538631 | 1794329550663 | Bloqueado: sin tool de edición; 0 archivos |
| `ses_e39a00fc1ffdMw9tp2phzECz7a` | 1794329538633 | 1794329558525 | Bloqueado: sin tool de edición; 0 archivos |

Las sesiones sí arrancaron con 2 ms de diferencia, pero el subagente nativo no
hereda los permisos de edición por worktree. **Paralelismo de sesiones sí;
implementación real no.**

### 11.2 Plan B (subtask_run + worktrees)

Se crearon dos worktrees desde `master` y se ejecutaron dos tareas
independientes en una sola llamada a `subtask_run`:

| Tarea | Sesión | `started_at` | `finished_at` | Duración | Coste |
|---|---|---|---|---|---|
| `par-a` | `ses_e39a0df8dffePHLUOpFCcXp09V` | 16:51:25.4205 | 16:51:37.823 | 12,40 s | US$0,001572 |
| `par-b` | `ses_e39a0df90ffewr0LaPe5vkp0F6` | 16:51:25.4176 | 16:51:34.207 | 8,79 s | US$0,001336 |

Ambas sesiones se crearon con **2 ms** de diferencia y sus intervalos se
solapan **8,79 s**. Las dos terminaron en `review`, con `src/par-a.js`/
`test/par-a.test.js` y `src/par-b.js`/`test/par-b.test.js`. Esto es evidencia
de ejecución concurrente real, no de dos ejecuciones secuenciales.

### 11.3 Fusión e integración

- `subtask_integrate par-b` → commit `c8705e3` en
  `factory/integration/fabrica-v2-synth`.
- `subtask_integrate par-a` → commit `f1d5ba7` en la misma rama.
- `git log --graph` muestra los dos merges `--no-ff` sobre
  `b541722 chore: baseline sintético`.
- `run_gates` en integración: `9c264ffa-68b9-4d48-9368-13c951ccaf9c`,
  **14/14 tests, 0 fallos**.

### 11.4 phase_close

`phase_close` sobre la fase 1 del plan `5a...`:

| Campo | Valor |
|---|---|
| `closure.id` | `111f1988-4f04-4106-b713-2da56327067a` |
| `status` | `closed` |
| `gate_run_id` | `9c264ffa-68b9-4d48-9368-13c951ccaf9c` |
| `report.sensitive` | `false` |
| `report.security_applicable` | `false` |
| `security_review_id` | `NULL` |
| `cost_usd` | US$0,028826 |
| `elapsed_ms` | 12.406 |

El primer intento de cierre fue bloqueado por el revisor de código porque el
prompt no incluía los criterios de aceptación de la fase y confundía el diff de
la fase con la suite completa del repo. Se corrigió `tools/factory/phase.ts`
para incluir los criterios y una nota sobre el gate; el segundo intento cerró.

Coste del anexo: US$0,002908 (subtasks) + US$0,028826 (revisiones/cierre) =
**US$0,031734**.

### 11.5 Reglas de severidad y worktrees

Se probó la lógica nueva con un plan ficticio:

| Caso | Esperado | Real |
|---|---|---|
| Solo MEDIO/BAJO + `confirmed=true` | Aprobar con deuda | `approved`, `approval_waiver.type=advisory_debt` |
| ALTO sin waiver | Bloquear | Error: faltan decisiones bloqueantes |
| ALTO aceptado + waiver | Aprobar con exención | `approved`, `approval_waiver.type=blocking_waiver` |
| CRÍTICO + waiver | Bloquear | Error: CRÍTICO no se puede waivear |
| CRÍTICO de ronda 1 + ALTO con waiver en ronda 2 | Bloquear | Error: CRÍTICO en historial; no se refuta ni waivea |
| CRÍTICO refutado con texto libre | Bloquear | Error: solo se cierra con ronda posterior aprobada sin CRÍTICO |
| `plan_review` en ronda 2 | `exhausted` con opciones | `exhausted: true`, opciones y métricas |
| `fix_and_revalidate` | `review_pending` | Correcto |
| `cancel` | `cancelled` con hallazgos | Correcto |
| Informe de fase con deuda | `review_exemptions` y `approval_waiver` | `phase_close` cerró con ambos campos en el reporte |

También se verificó:

- `subtask_run` creó el worktree en
  `~/.local/share/opencode/worktrees/fabrica-v2-synth/plan-...`.
- `subtask_run` detectó y commiteó una edición de un archivo tracked
  (`README.md`), no solo archivos nuevos.
- Un worktree fuera de la raíz (`~/malicious-worktree`) fue rechazado.
- Un cambio fuera de `files_owned` no dejó commit contaminado en la rama; el
  segundo intento escaló y el historial siguió con solo el commit de setup.
- `factory_doctor` detectó un `.git` roto (`worktrees:rotos`) y un directorio
  huérfano, y volvió a `66 ok, 0 warn, 0 error` tras limpiar.
- `plan_resume` marcó `failed` una tarea con worktree de `.git` roto.
- La integración con dos ramas que modifican `src/conflict2.js` fusionó la
  primera y abortó la segunda sin dejar `MERGE_HEAD`.

## 12. Conclusión

Los casos deterministas, el rechazo por `files_owned`, la escalada tras dos
fallos, la reanudación y la fase sin seguridad funcionan. El plan-reviewer
bloqueó los planes de 6 fases por hallazgos reales y el límite de 2 rondas
impidió aprobarlos; no se forzó ninguna aprobación. Se corrigieron tres bugs
reales: `escalated` en el rechazo de alcance, estado obsoleto en `plan_resume`
y falta de criterios de aceptación en el prompt de `phase_close`.

El anexo de paralelismo confirma que dos tareas independientes se ejecutan a la
vez en worktrees separados y que la fusión y el cierre de fase funcionan sobre
el plan aprobado `5a...`. Los subagentes nativos también arrancan en paralelo,
pero no heredan permisos de edición: sin el worktree y la política de sesión de
`subtask_run`, no pueden implementar.
