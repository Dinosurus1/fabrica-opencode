---
name: Factory Task Loop
description: Ciclo de trabajo de la fábrica: planificar, rama, implementar, verificar, revisar, commit y cierre con evidencia.
metadata:
  opencode/autoinvoke: false
---
# Ciclo de tarea

## 1. Entender y planificar

- Lee el código, tests, docs y perfil del proyecto.
- Divide en tareas pequeñas con criterio de aceptación verificable.
- Crea cada tarea con `task_create`.
- Si hay deuda previa, distínguela de los fallos nuevos.

## 2. Aislar

- Crea una rama de tarea con `git_branch` (por ejemplo `factory/<slug>`).
- Nunca trabajes ni commitees en `main`, `master` o `develop`.
- Si hay cambios sin commit en la rama actual, no los muevas a ciegas: inspecciona y decide.

## 3. Implementar

- Cambios mínimos, consistentes con el estilo del repo.
- No añadas dependencias sin justificarlo.
- No edites fuera del proyecto sin confirmación.

## 4. Verificar con compuertas

- Ejecuta `run_gates` con `task_id` e `iteration` (1-3). Empieza por las compuertas rápidas; la tool ya ordena por coste.
- Si hay fallos bloqueantes, conviértelos en subtareas (`task_create`) y corrige la causa raíz, no el síntoma.
- Re-ejecuta solo las compuertas afectadas y, antes del commit, la suite completa.
- Máximo 3 iteraciones por tarea. Si no converge, detente y reporta qué queda abierto.
- Lee `factory-quality-gates` para interpretar baseline, política y skips.

## 5. Revisión

- Con las compuertas en verde, carga `factory-review-loop`.
- Pasa a `@qa-engineer`, `@code-reviewer` y, si aplica, `@security-reviewer` el diff, los criterios de aceptación y la salida de `run_gates`.
- Cada revisor llama a `review_submit` con su propio veredicto; tú solo pasas `task_id`, `gate_run_id`, `iteration` y `model`. No lo guardes tú.
- Evalúa cada hallazgo: acéptalo, refútalo con evidencia o conviértelo en tarea. Registra la decisión.
- Corrige los válidos y vuelve a ejecutar las compuertas afectadas.

## 6. Commit

- Carga `factory-git-safety`.
- Usa `git_commit` con un mensaje Conventional Commits.
- No hagas push sin confirmación.

## 7. Cierre

- Guarda la memoria reutilizable y obtén su `memory_id`.
- Carga `factory-closure-report`.
- Usa `task_close` con criterios + evidencia, `memory_id`, revisores ya registrados y riesgos residuales. No uses `task_update` para marcar `done`.
