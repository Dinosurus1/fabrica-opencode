---
name: Factory Intake
description: Ingesta de un proyecto existente con documento de fases: leer código y docs, ejecutar baseline, evaluar seguridad y proponer plan sin cambiar alcance.
metadata:
  opencode/autoinvoke: false
---
# Ingesta de proyecto por fases

Objetivo: entender el proyecto y proponer un plan ejecutable **antes** de tocar
código. La salida es un borrador y un diff de fases; nada se aplica sin
aprobación.

## 1. Reunir contexto

- `project_profile_get` y `memory_search` en paralelo.
- Lee `AGENTS.md`, `README*`, `CONTRIBUTING*`, `docs/`, el documento de fases y
  los manifiestos.
- Ejecuta `project_detect` para stack, comandos candidatos y herramientas.
- Mapea el código real: estructura, puntos de entrada, tests, migraciones,
  configuración y CI. Contrasta lo que dice el documento con lo que existe.

Regla: si el documento y el código se contradicen, gana el código; anótalo como
hallazgo de ingesta, no lo "arregles" en silencio.

## 2. Verificar antes de planificar

- Si el perfil no está verificado, completa `factory-onboarding`: prueba los
  comandos reales y guarda `project_profile_set` con `verified: true`.
- Ejecuta `run_gates({ mode: "baseline" })`. Registra qué compuertas pasan,
  fallan, se omiten o dan error. La deuda previa no bloquea el plan, pero debe
  quedar visible.
- No inventes comandos que el repo no tenga.

## 3. Postura de seguridad

Revisa sin ejecutar nada destructivo:

- autenticación, sesiones, permisos y roles;
- entradas de usuario, SQL/ORM, plantillas y deserialización;
- subida/descarga/borrado de archivos y rutas;
- red, SSRF, webhooks y llamadas externas;
- secretos, configuración y dependencias;
- migraciones y datos personales.

Clasifica: **superficie sensible** / **sin superficie sensible** / **dudosa**.
Si es dudosa, trátala como sensible. Propón una pista de hardening separada; no
mezcles refactors de seguridad con features salvo que el usuario lo pida.

## 4. Diff de fases propuesto

Compara el documento con el estado real y propón cambios concretos:

- fases que sobran, faltan o están mezcladas;
- dependencias ocultas entre fases;
- tareas demasiado grandes para un implementer;
- archivos compartidos que obligan a serializar;
- criterios de aceptación no verificables;
- riesgos de seguridad que deben subir de fase.

Formato del diff:

```text
Fase N — <nombre>
  + añade: ...
  ~ cambia: ...
  - elimina: ...
  Motivo: ...
  Riesgo: ...
```

No edites el documento de fases ni el código en esta etapa.

## 5. Borrador de plan

Prepara `plan_create` (sin ejecutarlo si el usuario aún no aprobó el alcance):

- `title`, `autonomy: "supervised"`, `max_concurrency: 3`;
- `source_documents` con las rutas leídas;
- tareas con `key`, `phase`, `title`, `description`, `acceptance_criteria`,
  `difficulty`, `assignee`, `files_owned`, `depends_on`, `risk_flags`,
  `parallelizable`.

Reglas rápidas:

- Una tarea = un resultado verificable y un conjunto de archivos propio.
- `files_owned` con globs concretos; nunca `*` ni el repo entero.
- Lockfiles, configuración central, migraciones y rutas compartidas se marcan
  `parallelizable: false`.
- Si no sabes si una tarea es fácil, márcala `medium` y asígnala al
  orquestador. El triaje fino se hace con `factory-task-triage`.

## 6. Parar y pedir aprobación

Entrega:

1. stack y comandos verificados;
2. baseline con pass/fail/skipped/error y deuda previa;
3. postura de seguridad y pista de hardening;
4. diff de fases propuesto;
5. borrador de plan con riesgos y dudas;
6. qué **no** has verificado.

Espera aprobación explícita antes de `plan_create`, `plan_review` y cualquier
edición. No adaptes el alcance a un benchmark ni a una demo.
