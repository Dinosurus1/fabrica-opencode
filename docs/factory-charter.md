# Carta de la fábrica

> Documento de gobierno, no de operación. El día a día vive en
> `agents/factory.md` y en las skills `factory-*`. Carga esta carta al definir
> alcance, planificar un proyecto o auditar el proceso.

## 1. Misión

La fábrica recibe un proyecto o una funcionalidad, entiende el problema, define
alcance y criterios verificables, diseña lo necesario, implementa, verifica,
revisa, documenta y deja evidencia. No es un conjunto de skills para programar
más rápido: es un proceso con compuertas, separación de responsabilidades y
puntos de aprobación humana.

## 2. Principios

1. **Herramientas deterministas primero.** Lint, tipos, tests, compilación,
   seguridad, dependencias y Git los ejecutan herramientas reales. El modelo se
   reserva para razonar, diseñar, decidir y resolver problemas.
2. **Independencia del modelo.** Los roles se definen por contratos y permisos,
   no por un proveedor. Cambiar un modelo no obliga a rehacer la fábrica.
3. **La fábrica demuestra su trabajo.** «Terminado» exige evidencia, pruebas,
   resultados y limitaciones. Compilar no es terminar.
4. **Núcleo pequeño, especializaciones bajo demanda.** No se carga conocimiento
   que el proyecto no usa. Los roles de análisis, arquitectura y documentación
   se activan cuando la etapa los necesita, no por defecto.
5. **Nada avanza sin compuerta.** Si una etapa no cumple su criterio de salida,
   no pasa a la siguiente.
6. **Una sola fuente de verdad.** Tareas, compuertas, revisiones y planes viven
   en PostgreSQL. `docs/` guarda especificaciones, decisiones y runbooks. No se
   mantienen dos tableros paralelos.

## 3. Capas

| Capa | Qué es | Dónde vive |
|---|---|---|
| Factory Core | Orquestación, permisos, ejecución | `agents/factory.md`, `opencode.json` |
| Estado | Tareas, compuertas, revisiones, planes, coste | PostgreSQL (`tasks`, `gate_runs`, `review_runs`, `plans`, …) |
| Model & Agent Management | Catálogo, perfiles de ejecución, asignación por rol y auditoría | PostgreSQL + RPC `opencode.factory` + `ui/` |
| Procedimientos | Onboarding, ingesta, tareas, compuertas, revisión, cierre, fases | `skills/factory-*` |
| Roles | Responsabilidades y límites de cada subagente | `agents/` |
| Conocimiento | Requisitos, arquitectura, ADR, runbooks | `docs/` del proyecto |
| Perfil | Stack, comandos verificados, convenciones | `project_profile_*` en PostgreSQL |
| Evidencia | Informes de cierre y deuda residual | `task_close`, `phase_close`, `docs/` |

## 4. Pipeline

El pipeline se adapta al tamaño. Un bug acotado no necesita análisis de producto
ni arquitectura; un proyecto nuevo o un cambio que cruza módulos sí.

| # | Etapa | Responsable | Entregable | Compuerta de salida |
|---|---|---|---|---|
| 1 | Recepción | `factory` | Objetivo, restricciones y tipo de trabajo | Solicitud entendida y clasificada |
| 2 | Análisis | `product-analyst` | Requisitos, alcance, criterios verificables, preguntas abiertas | Alcance cerrado y aceptado; sin arquitectura ni código |
| 3 | Arquitectura | `architect` | Módulos, contratos, datos, ADR, riesgos | Contratos y módulos afectados definidos; sin implementación |
| 4 | Planificación | `factory` | Tareas con dueño, dependencias, archivos y criterios | `plan_validate` en verde y `plan_review` aprobado |
| 5 | Desarrollo | `factory` / `implementer` | Código en rama de tarea o worktree | Cambios dentro de `files_owned`; sin tocar ramas protegidas |
| 6 | Validación | `run_gates` / `run_checks` | Evidencia de compuertas | Sin fallos bloqueantes nuevos; los skips se explican |
| 7 | Auditoría | `code-reviewer`, `qa-engineer`, `security-reviewer` | Veredictos independientes | Sin hallazgos bloqueantes abiertos |
| 8 | Aprobación | humano | Visto bueno | Aprobación explícita en operaciones sensibles y entrega |
| 9 | Despliegue | fuera de la fábrica | Runbook y rollback | Health checks y rollback probados; nunca automático |
| 10 | Mantenimiento | `factory` | Deuda, incidencias, memoria | Registro en el plan, la tarea o `docs/` |

**Reglas duras:**

- Ningún desarrollo empieza sin alcance y criterios de aceptación verificables.
- Antes de un cambio que cruce módulos, se identifican componentes y contratos
  que pueden romperse.
- Un rol no avanza si su entregable no existe o no es verificable.
- La revisión es independiente: el revisor recibe criterios y diff, no la
  conclusión del autor.
- Nunca se integra ni se commitea en `main`, `master` o `develop`.

## 5. Roles

| Rol | Cuándo se activa | Entregable | No hace |
|---|---|---|---|
| `factory` | Siempre | Orquestación, tareas, compuertas, integración y cierre | No aprueba su propio trabajo ni escribe código de producto en modo fases |
| `product-analyst` | Alcance ambiguo, requisitos incompletos, cambio de alcance | `docs/requirements.md` o `docs/requirements/<slug>.md` | No decide arquitectura, no estima en solitario, no implementa |
| `architect` | Cambio que cruza módulos, contratos, datos o infraestructura | `docs/architecture.md` y ADR en `docs/decisions/` | No implementa, no cambia requisitos, no aprueba el plan |
| `implementer` | Tarea pequeña y aislada del plan | Cambio en su worktree, dentro de `files_owned` | No ejecuta shell, no commitea, no revisa su trabajo |
| `qa-engineer` | Validación independiente | Evidencia por criterio, tests propuestos, veredicto | No edita código ni se autovalida |
| `code-reviewer` | Revisión de diseño y mantenibilidad | Hallazgos por severidad y veredicto | No edita, no ejecuta tests |
| `security-reviewer` | Diff con superficie sensible | Hallazgos de seguridad con evidencia | No corrige código |
| `plan-reviewer` | Antes de aprobar un plan por fases | Veredicto del plan y hallazgos | No edita el plan ni lo aprueba |
| `tech-writer` | Entrega, handoff o documentación desactualizada | README, CHANGELOG, guías y runbooks | No cambia especificaciones ni inventa comportamiento |
| `devops-engineer` | Release, Docker/CI, health checks o rollback | Cambios de infra/CI, runbook y rollback probado | No despliega producción sin aprobación humana |
| `memory-consolidator` | Duplicados, conflictos o memoria antigua | JSON de consolidación (`clusters`, `conflicts`, `confidence`) | No edita, no borra y no aplica cambios |
| `helper` | Segunda opinión breve o documentación con citas | Respuesta acotada | No sustituye compuertas ni revisiones |
| `researcher` | Información cambiante fuera de la documentación oficial | Hallazgos con fuentes | No decide arquitectura ni implementa |
| `explore` | Búsqueda rápida en el código | Rutas y hallazgos | No edita |

## 6. Activación de roles

Los roles de análisis, arquitectura y documentación **no se ejecutan siempre**.
El orquestador los activa cuando la etapa lo requiere y lo justifica:

- `product-analyst`: cuando el alcance no está cerrado o hay ambigüedades que no
  puede resolver el código.
- `architect`: cuando hay que decidir contratos, modelo de datos, límites de
  módulos o una integración que puede romper otros componentes.
- `tech-writer`: cuando hay que transferir el trabajo, actualizar documentación
  pública o dejar un runbook verificable.
- `memory-consolidator`: cuando `memory_consolidation_plan` detecta duplicados,
  conflictos o clusters de baja confianza; solo propone JSON y el orquestador
  aplica tras aprobación humana.

Condiciones:

1. **No duplicar responsabilidades.** El analista define requisitos, no
   arquitectura. El arquitecto diseña, no implementa. El redactor documenta lo
   que existe, no cambia especificaciones.
2. **Entregable verificable.** Cada rol escribe su artefacto en una ruta
   conocida o devuelve el contenido estructurado si no puede escribir. El
   orquestador revisa el artefacto; no basta con que el subagente diga que lo
   hizo.
3. **Coste justificado.** Para una tarea trivial no se activa un rol adicional.
   Si el rol no aporta un artefacto que cambie la decisión, se omite.
4. **Skills acotadas.** Cada agente declara qué skills puede cargar con reglas
   `skill` de sus permisos. Las skills que no aportan a su rol no se listan ni
   gastan contexto.

## 7. Evidencia de finalización

El formato operativo está en la skill `factory-closure-report`. Como mínimo:

```text
Tarea: <id/título>                 Estado real: done | parcial | bloqueada
Archivos modificados:              ...
Pruebas ejecutadas:                <comando> → <resultado>
Criterios de aceptación:           <criterio> → cumple / no cumple + prueba
Regresiones:                       ninguna | lista
Problemas pendientes:              ...
Decisiones tomadas:                ADR o nota
Versiones y comandos:              ...
Compuertas y revisores:            ...
Riesgos residuales:                ...
```

Un criterio sin prueba que lo demuestre se reporta como **no cumplido**. Un
skip no es un pass. Un fallo de escáner es `error`, no `pass`.

## 8. Presupuestos y economía

Tres niveles: proyecto, fase y agente. Distribución ilustrativa, no universal:

| Fase | % |
|---|---|
| Análisis | 10 |
| Arquitectura | 10 |
| Desarrollo | 45 |
| Testing y auditoría | 20 |
| Documentación y entrega | 5 |
| Reserva | 10 |

- Alertas de consumo, límite de iteraciones y de contexto por agente.
- Se reutilizan análisis y resultados deterministas si el código no cambió.
- La métrica clave es **coste de entregar una funcionalidad correctamente
  terminada**, no coste por petición.
- Los costes reales salen de `task_close`, `phase_close` y del execution log; no
  se rellenan a mano.
- **Modos de modelo:** `manual` usa el modelo asignado por rol; `auto` elige en
  código con política, factibilidad, presupuesto e historial; `hybrid` es auto con
  aprobación en tareas sensibles, modelos más caros o reintentos. El LLM solo
  clasifica la dificultad.
- **Reserva atómica:** `subtask_run`/`review_run` reservan en global, fase y
  tarea antes de crear la sesión, y liquidan el uso real al terminar. La unidad
  es coste si hay precio versionado; tokens ponderados si no. Si no cabe, la
  tarea queda pendiente/en review y se pide ampliar, no se mata. Aviso al 80 %;
  sobreconsumo repetido >1,5x lo detecta el doctor y recalibra con el percentil 90
  histórico cuando hay suficientes ejecuciones. `token_budget` no es un límite de
  salida de la API.
- **Execution log:** cada ejecución deja una fila al empezar y otra al terminar,
  con agente, modelo, modo, motivo de selección, tokens, coste, estado, intento,
  error, versiones y gate. Alimenta la evaluación de modelos y el coste por tarea.

## 9. Aprobación humana

Requieren confirmación explícita:

- Push, deploy y merges a ramas protegidas.
- Migraciones destructivas, borrado de datos o cambios irreversibles.
- Nuevas dependencias con licencia no permisiva.
- Cambios de alcance.
- Gasto por encima de la alerta acordada.
- Instalación de software o comandos destructivos.

La fábrica commitea en local; el push y el deploy los decide el usuario.

## 10. Gobierno y evaluación

- Cada proyecto declara qué herramientas y modelos están autorizados y qué
  operaciones requieren aprobación.
- Los modelos se eligen por resultados medidos: tareas completadas, errores
  introducidos, coste por tarea terminada, tiempo, consistencia y seguimiento de
  instrucciones.
- El ruteo de modelos vive en `tools/factory/routing.ts`; los prompts no
  hardcodean modelos.
- La revisión siempre es de una familia distinta a la del autor cuando la tool
  lo permite.

## 11. Recuperación y mantenimiento

- Checkpoint tras cada fase; el estado vive en PostgreSQL.
- `plan_resume` reconcilia sesiones y worktrees; `factory_doctor` detecta
  huérfanos y tareas colgadas.
- Máximo 3 iteraciones por tarea; si no converge, se detiene y se reporta.
- La deuda técnica se registra en el plan o en la tarea; no se oculta en la
  conversación.

## 12. Áreas transversales

Legal y licencias · privacidad y datos personales · FinOps · accesibilidad ·
observabilidad · gestión de releases (semver, changelog, migraciones y
rollback) · documentación de transferencia. Se activan cuando el proyecto las
necesita; no se cargan por defecto.
