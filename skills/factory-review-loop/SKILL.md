---
name: Factory Review Loop
description: Delegación a revisores, review_submit, evaluación de hallazgos y cierre con task_close.
metadata:
  opencode/autoinvoke: false
---
# Bucle de revisión

## Cuándo

Solo cuando `run_gates` está en verde (o solo quedan advertencias aceptadas). No revises encima de fallos bloqueantes.

## Revisores

- `@qa-engineer`: tests adversariales, casos borde, entradas inválidas, concurrencia, errores; criterio → evidencia.
- `@code-reviewer`: criterios de aceptación, diseño, mantenibilidad, errores y convenciones.
- `@security-reviewer`: auth, entradas, SQL, archivos, red, secretos, dependencias; incluye TOCTOU, mass assignment, SSRF y JWT.

Pásales:
- diff (`git diff`) y rutas;
- criterios de aceptación;
- salida resumida de `run_gates` (no logs gigantes);
- si aplica, modo offline/online y hallazgos de escáneres.

Pide su formato fijo. No les pidas que editen.

## review_submit

**Cada revisor llama a la tool con su propio veredicto.** El orquestador solo pasa `task_id`, `gate_run_id`, `iteration` y `model`, y verifica que la fila exista. No lo guardes tú ni lo dejes como texto libre:

```json
{
  "task_id": "...",
  "role": "qa|code|security",
  "model": "opencode-go/...",
  "verdict": "approved|changes_required",
  "findings": [
    { "severity": "high", "file": "src/x.js", "line": 10, "problem": "...", "action": "...", "blocking": true }
  ],
  "summary": "...",
  "gate_run_id": "...",
  "iteration": 1
}
```

`open_blocking` se calcula desde `blocking: true`. Un `approved` con bloqueantes es rechazado.

## Evaluar hallazgos

- Verifica cada hallazgo contra el código y las compuertas.
- Si es falso positivo, refútalo con evidencia y no lo corrijas.
- Si es válido, crea tarea/corrección y vuelve a ejecutar las compuertas afectadas.
- No aceptes un hallazgo solo porque el revisor lo diga; no lo descartes sin comprobarlo.
- Si un revisor no pudo revisar algo, queda en el informe.

## Convergencia

- Máximo 3 iteraciones por tarea.
- Si tras la tercera sigue habiendo fallos bloqueantes, no cierres: reporta qué falta.
- Antes de `task_close`, la última ejecución debe ser `run_gates` en modo `check` y en verde.

## task_close

Exige:
- último `gate_run` `pass`;
- revisiones `code` y `qa` aprobadas, y `security` si el diff toca SQL, entradas, auth, archivos, red, secretos o dependencias (lo calcula `task_close`);
- `open_blocking: 0` en cada revisor;
- criterios con evidencia;
- `memory_id` que exista en `memories` y sea del proyecto o global;
- rama no protegida;
- riesgos residuales;
- waivers solo para skips bloqueantes aceptados explícitamente.

Si falta algo, corrige y repite; no fuerces el cierre.
