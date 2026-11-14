---
name: Factory Pipeline
description: Decide la etapa del pipeline y activa bajo demanda product-analyst, architect o tech-writer. Úsala al recibir un proyecto, una fase o una funcionalidad con alcance ambiguo.
metadata:
  opencode/autoinvoke: false
---
# Pipeline y roles bajo demanda

Objetivo: saber qué etapa toca, qué rol se activa y qué entregable verificable se
exige. No ejecutes todos los roles por defecto y no conviertas el pipeline en una
cadena burocrática.

## 1. Clasificar la entrada

| Señal | Etapa | Rol | Siguiente paso |
|---|---|---|---|
| Proyecto nuevo, funcionalidad grande o alcance ambiguo | Análisis | `@product-analyst` | Requisitos cerrados → arquitectura o plan |
| Requisitos claros, pero el cambio cruza módulos, contratos, datos o infraestructura | Arquitectura | `@architect` | ADR y contratos → plan |
| Bug acotado, tarea mecánica o cambio de una sola capa | Desarrollo | Ninguno | `factory-task-loop` |
| Plan por fases ya aprobado | Ejecución | Ninguno | `factory-phase-orchestration` |
| Implementación o fase cerrada, handoff o documentación desactualizada | Transferencia | `@tech-writer` | Documentación → `task_close` / `phase_close` |

Si dudas entre análisis y arquitectura, empieza por análisis. Si el alcance ya
está cerrado y el diseño es evidente, no actives ningún rol: sería coste sin
decisión.

## 2. Etapas y compuertas

| # | Etapa | Herramienta / rol | Entregable | Compuerta |
|---|---|---|---|---|
| 1 | Recepción | `factory` | Objetivo y tipo de trabajo | Solicitud clasificada |
| 2 | Análisis | `product-analyst` | Requisitos y criterios verificables | Alcance cerrado; preguntas abiertas explícitas |
| 3 | Arquitectura | `architect` | Arquitectura, contratos y ADR | Módulos afectados y contratos definidos |
| 4 | Planificación | `plan_create`, `plan_validate`, `plan_review` | Plan por fases | Validación en verde y revisión aprobada |
| 5 | Desarrollo | `factory` o `subtask_run` | Cambio en rama o worktree | Dentro de `files_owned`; sin ramas protegidas |
| 6 | Validación | `run_gates`, `run_checks` | Evidencia de compuertas | Sin fallos bloqueantes nuevos |
| 7 | Auditoría | `review_run` / revisores | Veredictos independientes | Sin bloqueantes abiertos |
| 8 | Aprobación | Humano | Visto bueno | Aprobación explícita si es sensible |
| 9 | Transferencia | `tech-writer` | README, CHANGELOG, runbooks | Documentación verificable y sin invenciones |
| 10 | Cierre | `task_close` / `phase_close` | Informe con evidencia y coste | Todo lo anterior en verde |

La etapa 9 puede ocurrir antes del cierre o después de una fase; no bloquea el
desarrollo si no hay cambios de comportamiento que documentar.

**Despliegue:** si la tarea es un release, un cambio de infraestructura o un
rollback, activa `@devops-engineer` y carga `factory-deployment`. Producción
exige aprobación humana explícita, health check y rollback probado.

## 3. Activación de roles

### `@product-analyst`

Actívalo cuando:

- El usuario pide «algo» sin alcance cerrado.
- Hay requisitos contradictorios o incompletos.
- Hay que decidir qué entra y qué no entra antes de planificar.
- Un cambio de alcance exige renegociar criterios.

Entrada mínima: objetivo, contexto del repo, documentos existentes y
restricciones. No le pases la conversación completa.

Entregable: `docs/requirements.md` o `docs/requirements/<slug>.md` con:

- Contexto y problema.
- Alcance y fuera de alcance.
- Actores y flujos.
- Requisitos funcionales y no funcionales con ID.
- Historias con criterios de aceptación verificables.
- Riesgos, dependencias y preguntas abiertas.
- Trazabilidad requisito → criterio → prueba prevista.

Compuerta: el alcance está cerrado, cada criterio se puede verificar con un test
o comando, y las ambigüedades están explícitas. **No decide arquitectura.**

### `@architect`

Actívalo cuando:

- El cambio cruza módulos o contratos.
- Hay que decidir modelo de datos, límites, APIs o integración.
- Hay más de una opción técnica razonable y la decisión importa.
- La implementación puede romper consumidores existentes.

Entrada mínima: requisitos, código relevante, perfil del proyecto y restricciones.

Entregable: `docs/architecture.md` y uno o más ADR en `docs/decisions/` con:

- Contexto y decisiones.
- Módulos y responsabilidades.
- Contratos, APIs y modelo de datos.
- Componentes afectados y contratos en riesgo.
- Alternativas descartadas y consecuencias.
- Diagramas C4 si aportan; no como relleno.
- Riesgos y supuestos.

Compuerta: los contratos y módulos afectados están definidos, las decisiones
tienen ADR y no hay código de producto. **No implementa ni cambia requisitos.**

### `@devops-engineer`

Actívalo cuando:

- Hay que preparar un release o un rollback.
- Hay que tocar Docker, CI/CD, infraestructura o entornos.
- Hace falta un runbook con health checks y rollback.

Entregable: cambios de infraestructura/CI, `docs/runbooks/**`, health check,
smoke test y rollback probado en staging. **No despliega a producción sin
aprobación humana.**

### `@tech-writer`

Actívalo cuando:

- Hay que entregar o transferir el proyecto.
- El README, CHANGELOG o los runbooks no reflejan el comportamiento actual.
- Hace falta un manual de instalación, operación o rollback.
- Una fase se cierra y hay que dejar constancia para el siguiente equipo.

Entrada mínima: código, ADR, requisitos, diff y evidencia de compuertas. No le
pidas que «invente» documentación de lo que no existe.

Entregable: `README.md`, `CHANGELOG.md`, `docs/runbooks/**`, `docs/guides/**`,
`docs/manual/**` o `docs/usage/**`, con:

- Comandos y rutas reales.
- Requisitos previos, pasos, verificación y rollback.
- Enlaces a ADR, requisitos y código.
- Qué no se pudo verificar.

Compuerta: la documentación describe el comportamiento real, los comandos
citados existen y lo no verificado está marcado. **No cambia especificaciones.**

## 4. Handoff

```text
product-analyst → architect → plan_create → implementer → run_gates
→ review_run → tech-writer → task_close / phase_close
```

- No lances `architect` si `product-analyst` todavía tiene preguntas abiertas que
  cambian el alcance.
- No lances `tech-writer` sobre una implementación que aún no pasó compuertas.
- No lances los tres en paralelo: dependen unos de otros.
- Si el rol no puede escribir su archivo por permisos, debe devolver el
  contenido estructurado y el orquestador decide dónde guardarlo. No simules que
  el archivo existe.

## 5. Reglas del orquestador

- Activa un rol solo si su entregable cambia una decisión o desbloquea una
  etapa. Si no, omítelo.
- Pasa contexto mínimo: objetivo, requisitos, código relevante y restricciones.
- Revisa el entregable antes de avanzar; no confíes en el resumen del subagente.
- Registra en la tarea o el plan qué rol se activó, qué produjo y qué coste
  aproximado tuvo.
- Si el rol detecta un cambio de alcance, detente y pide aprobación humana. No
  lo implementes.
- Ningún rol sustituye las compuertas, la revisión independiente ni
  `task_close`.

## 6. Modos, presupuesto y evidencia de ejecución

Hay dos modos distintos; no los mezcles:

| Eje | Valores | Dónde vive | Quién decide |
|---|---|---|---|
| Selección de agentes | `manual`, `hybrid`, `auto` | `factory_meta` por proyecto | Usuario + recomendación determinística |
| Modelo por rol | `manual`, `auto`, `hybrid` | Perfil MAM | Código (`selectModel`) y política |

- **Agentes**: `factory_agents_get` → `factory_agents_propose` → `factory_agents_select` → `factory_agents_apply`. Antes de lanzar un subagente, `factory_agents_check`; si no está aprobado, pide permiso.
- **Modelo**: `manual` usa el modelo asignado; `auto` elige con política, presupuesto e historial; `hybrid` exige `confirmed=true` en tareas sensibles, modelos más caros o reintentos.
- **Presupuesto**: `budget_set` global/fase/tarea; `subtask_run`/`review_run` reservan antes de crear la sesión y liquidan al terminar. El `token_budget` es ponderado y no es un límite de salida. Si no hay saldo, la tarea queda pendiente/en review y se pide ampliar; no se marca fallida. Si hay `budget_warnings` (≥80 %) avisa al usuario.
- **Evidencia**: `executions_list` y `model_history` muestran agente, modelo, tokens, coste, estado, intento y motivo. La métrica es coste por tarea terminada correctamente.

## 7. Salida del orquestador

Cuando uses esta skill, deja claro en tu respuesta:

```text
Etapa: <...>
Rol activado: <ninguno | product-analyst | architect | tech-writer>
Entregable: <ruta o contenido>
Compuerta: <cumple | falta ...>
Siguiente paso: <...>
```
