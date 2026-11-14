# Reglas de revisión del plan

Fecha: 2026-11-10. Evidencia de los dos planes de 6 fases de la Etapa D.
Los planes se eliminaron de PostgreSQL después de la validación; este documento
conserva los hallazgos.

## Hallazgos abiertos por plan

### Plan `becbc233` · 6 fases inicial

Ronda 1: 14 hallazgos (4 ALTO, 7 MEDIO, 3 BAJO). Ronda 2: 11 hallazgos
(1 ALTO, 4 MEDIO, 6 BAJO). **Abiertos tras la ronda 2: 11.**

| Severidad | Hallazgo |
|---|---|
| ALTO | `dc07edd7` documenta seguridad con un modelo flash sin justificar que baste. |
| MEDIO | `76be83a3`/`87020996`: contrato de entradas no string ambiguo entre T1 y T6. |
| MEDIO | `8baee9e1`: la documentación no depende de T6, que fija el contrato de casos borde. |
| MEDIO | `dc07edd7`: `grep` sensible a mayúsculas y sin código de salida registrado. |
| MEDIO | `e79d741d`: el estado de `npm test` no es verificable y no hay compuerta final. |
| BAJO | `6b19b7fb`: `orderIndex` no coincide con el orden de fases. |
| BAJO | `6b19b7fb`: la descripción menciona `package.json`, que ya está correcto y no está en `files_owned`. |
| BAJO | Criterios autorreferenciales: los tests los escribe el mismo implementer. |
| BAJO | `76be83a3`: no define si `'  a  '` es válido. |
| BAJO | `8baee9e1`: el criterio no comprueba que los ejemplos sean correctos. |
| BAJO | El plan está `validated` con `approvedAt: null`; falta la aprobación humana. |

### Plan `6af200be` · 6 fases corregido

Ronda 1: 10 hallazgos (1 ALTO, 6 MEDIO, 3 BAJO). Ronda 2: 12 hallazgos
(2 ALTO, 5 MEDIO, 5 BAJO). **Abiertos tras la ronda 2: 12.**

| Severidad | Hallazgo |
|---|---|
| ALTO | `c8df2de9`: el criterio exige un baseline fijo de 10 tests, pero las fases anteriores añaden más; el criterio es imposible. |
| ALTO | `48cd6987`: T1 no crea tests y la fase 0 se puede cerrar sin tests de validación. |
| MEDIO | `6688c700`: `scripts/check-docs.js` no está en `docs/fases.md`; alcance no aprobado. |
| MEDIO | `6688c700`: el criterio de ejemplos no define cómo se verifican ni evita ejecutar código desde Markdown. |
| MEDIO | `c9754f05`: el `grep` de seguridad no cubre `scripts/` ni configuración. |
| MEDIO | `1cae9240`: `parallelizable: false` pero aparece en la misma ola que una tarea paralela. |
| MEDIO | `c8ee0cea`: el resumen de `npm test` no obliga a que el cierre dependa del resultado. |
| BAJO | `48cd6987`: “espacios” no define `trim()` ni caracteres Unicode. |
| BAJO | `58217747`: `clamp` no documenta el comportamiento fuera de alcance. |
| BAJO | `feb26825`: dependencias artificiales con T1/T2. |
| BAJO | `c8df2de9`: `parallelizable: true` aunque depende de todas las anteriores. |
| BAJO | Política de asignación medium no documentada. |

### Planes de harness (referencia)

- `a2cddf62`: 5 hallazgos en ronda 1 (2 ALTO, 2 MEDIO, 1 BAJO).
- `8baf80ef`: 11 hallazgos en ronda 1 (1 CRÍTICO, 3 ALTO, 4 MEDIO, 3 BAJO).
- El CRÍTICO era real: los criterios de la tarea de sabotaje exigían que los
  tests pasaran mientras el harness esperaba `failed`/`escalated`.

## Regla implementada

Implementada en `tools/factory/plan-review.ts`, `tools/factory/plan.ts`,
`tools/factory/review-severity.ts` y la migración 005:

- `plan_reviews` guarda `blocking_count`, `advisory_count`, `new_findings` y
  `resolved_findings` por ronda.
- `plan_review` devuelve `exhausted` con `blocking`, `advisory` y `metrics`
  cuando se agotan las 2 rondas. Una tercera ronda exige `confirmed=true`.
- Un `CRÍTICO` no se puede refutar ni waivear desde `plan_update`: solo se
  cierra con una ronda posterior **aprobada** que ya no lo reporte. Un `ALTO`
  refutado exige evidencia y no se mezcla con el waiver de un `CRÍTICO`.
- El prompt de `plan_review` incluye los hallazgos de la ronda anterior y pide
  repetirlos si siguen vigentes. Una aprobación sin sección `Hallazgos:` con
  contenido, o que menciona `CRÍTICO` sin parsearlo, se rechaza.
- `plan_update` acepta `exhausted_decision`:
  - `approve_with_waiver`: exige `confirmed=true` y `waiver` si hay ALTO; los
    CRÍTICO no se pueden waivear.
  - `fix_and_revalidate`: deja el plan en `review_pending` para corregir y
    volver a revisar.
  - `cancel`: deja el plan `cancelled` con los hallazgos.
- `MEDIO`/`BAJO` se guardan como `residual_findings` y `approval_waiver` con
  `type: "advisory_debt"`; no bloquean si `confirmed=true`.
- `phase_close` copia `review_exemptions` y `approval_waiver` al informe de
  fase.

## Regla propuesta original

### Severidad

| Severidad | ¿Bloquea aprobación? | Tratamiento |
|---|---|---|
| `CRÍTICO` | Sí | Corregir y revalidar; no se aprueba con waiver. |
| `ALTO` | Sí | Corregir o refutar con evidencia; el waiver exige decisión humana explícita. |
| `MEDIO` | No | Se registra como deuda residual; se puede aprobar con `confirmed=true`. |
| `BAJO` | No | Se registra como deuda residual; se puede aprobar con `confirmed=true`. |

### Aprobación

1. `plan_validate` debe estar en verde.
2. Si hay algún `CRÍTICO`/`ALTO` abierto, `plan_update(status="approved")` falla.
3. Si solo quedan `MEDIO`/`BAJO`, se permite aprobar con `confirmed=true` y se
   guardan en `plans.residual_findings` (nuevo campo o dentro de `metadata`).
4. Un hallazgo `accepted` de severidad no bloqueante no invalida la validación;
   solo se registra. Un `accepted` bloqueante sí la invalida.
5. Un `refuted` siempre exige evidencia y se guarda.

### Cuando se agotan las rondas

`plan_review` no debe devolver un error seco al llegar a 2 rondas. Debe
devolver:

```json
{
  "exhausted": true,
  "plan_id": "...",
  "round": 2,
  "blocking": [{ "severity": "ALTO", "finding": "..." }],
  "advisory": [{ "severity": "MEDIO", "finding": "..." }],
  "options": ["approve_with_waiver", "fix_and_revalidate", "cancel"]
}
```

El orquestador presenta ese resumen al usuario y **no crea otro plan por su
cuenta**. El usuario decide:

- `approve_with_waiver`: solo si no hay `CRÍTICO`; exige `confirmed=true` y
  justificación escrita.
- `fix_and_revalidate`: se corrigen los bloqueantes, se revalida y se permite
  una ronda extra solicitada explícitamente.
- `cancel`: el plan queda `cancelled` con los hallazgos guardados.

### Cambios aplicados

- `tools/factory/plan-review.ts`: `exhausted` con bloqueantes/advisorios y
  métricas; tercera ronda con `confirmed=true`.
- `tools/factory/plan.ts`: filtro de `accepted` por severidad; aprobación con
  deuda o waiver; `exhausted_decision`; `residual_findings` y
  `approval_waiver`.
- `tools/factory/plan-db.ts`: persistencia de `review_exhausted`,
  `residual_findings`, `approval_waiver` y las cuatro métricas por ronda.
- `plugins/factory/migrations/005_review_severity.sql`: columnas, constraints
  0-3/1-3 y `schema_version=5`.
- `tools/factory/phase.ts`: informe de fase con `review_exemptions` y
  `approval_waiver`.
- `tools/factory/review-severity.ts`: normalización y resumen de severidad.
- Verificación: `tsc` en verde y `factory_doctor` con `schema_version=5` en el momento de esta validación. La migración 006 eleva el esquema a 6; `factory_doctor` ya espera 6.
