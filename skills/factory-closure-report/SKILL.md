---
name: Factory Closure Report
description: Formato y evidencia mínima del informe de cierre; requisitos de task_close.
metadata:
  opencode/autoinvoke: false
---
# Informe de cierre

Toda tarea termina con este informe, en español y sin relleno:

```text
Tarea: <id/título>

Criterios → evidencia:
- [criterio] → comando/test/archivo que lo demuestra

Compuertas:
- gate — pass | fail | skipped (razón) | error
- gate_run: <id>, iteración <1-3>

Revisores:
- qa — APROBADO/CAMBIOS REQUERIDOS — hallazgos y qué se hizo
- code — ...
- security — ... (si aplica)

Uso y costo (lo calcula task_close; no lo inventes):
- <modelo> — <rol> — entrada N, salida N, razonamiento N, caché lectura/escritura N — $X (proveedor|catálogo|desconocido)
- orquestador — sesión acumulada (puede incluir otras tareas) — $X
- total estimado — $X
- nota: costo de catálogo = USD por millón de tokens; no es una factura

Cobertura:
- nueva: ...; baseline: ...; delta: ...

Riesgos residuales:
- ...

Memoria:
- id, scope, qué se guardó

Waivers:
- gate — motivo (solo si hay skips bloqueantes aceptados)
```

## Antes de task_close

- Último `run_gates` en modo `check` con `status: "pass"`.
- `review_submit` para `code` y `qa`; `security` si el cambio lo requiere. `task_close` calcula `security_applicable` del diff (SQL, entradas, auth, archivos, red, secretos, dependencias). Si el diff toca esas categorías y no quieres revisión de seguridad, debes pasar `security_justification`; queda guardada en el informe.
- Cada revisor con `verdict: "approved"` y `open_blocking: 0`.
- Cada criterio de aceptación con evidencia.
- `memory_id` real, guardado en `memories` y del proyecto/global.
- Rama no protegida.
- Riesgos residuales escritos.

`task_close` guarda este informe estructurado en la tarea. Si falta algo, no cierres.

`task_close` lee de OpenCode los tokens y el costo de la sesión de cada revisor y del orquestador. Si el proveedor no reporta costo, lo estima con el catálogo de modelos y lo marca como `catalog`; si no hay precio, lo marca `unknown`. No rellenes esas cifras a mano. El costo del orquestador es el acumulado de su sesión y puede incluir otras tareas; se muestra con esa etiqueta y no se presenta como costo exacto de la tarea.

## Reglas

- No declares "listo" sin evidencia.
- Un skip o una compuerta no disponible se muestra; no se oculta.
- No incluyas secretos ni cadenas de conexión.
- Si no convergió en 3 iteraciones, dilo y enumera lo que quedó abierto.
