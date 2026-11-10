---
name: Factory Task Triage
description: Clasifica tareas de un plan por dificultad, sensibilidad, archivos y dependencias para decidir si las hace el orquestador o un implementer, con qué modelo y en qué ola.
metadata:
  opencode/autoinvoke: false
---
# Triaje de tareas

Objetivo: que cada tarea llegue al ejecutor correcto, con el alcance cerrado y
sin pisar a otra tarea en paralelo.

## 1. Clasificar dificultad

| Dificultad | Señales | Ejecutor por defecto |
|---|---|---|
| `easy` | Cambio local, patrón existente, pocos archivos, criterio claro. | `implementer` |
| `medium` | Varios archivos, algo de diseño, tests nuevos, integración sencilla. | `implementer` con revisión estricta u orquestador |
| `hard` | Arquitectura, concurrencia, migraciones, seguridad, rendimiento o incertidumbre alta. | `orchestrator` |

Si dudas entre dos niveles, elige el superior. Una tarea `hard` no se delega
solo porque el modelo sea barato.

## 2. Sensibilidad

Marca `risk_flags` y sube la dificultad si toca:

- autenticación, sesiones, permisos, roles o criptografía;
- pagos, facturación o datos personales;
- SQL/ORM construido con entradas, plantillas o deserialización;
- subida, descarga o borrado de archivos y rutas;
- red, SSRF, webhooks o llamadas externas;
- secretos, configuración de seguridad o dependencias;
- migraciones o cambios de esquema.

Una tarea sensible va al orquestador o a un implementer con revisión de
seguridad obligatoria. Nunca la marques `easy` para ahorrar coste.

## 3. Archivos y paralelismo

- `files_owned` debe ser un conjunto concreto de globs. Si dos tareas se solapan,
  no pueden ir en la misma ola.
- Lockfiles, `package.json`, configuración central, rutas de registro,
  migraciones y documentación global se serializan (`parallelizable: false`).
- Si una tarea necesita un archivo compartido, conviértelo en tarea previa del
  orquestador o reduce el alcance.
- Si el diff real toca algo fuera de `files_owned`, la tarea falla; no negocies
  el límite después del commit.

## 4. Dependencias

- `depends_on` solo cuando la tarea no puede empezar sin el resultado anterior.
- No encadenes tareas que solo comparten tema; eso destruye el paralelismo.
- Un ciclo es un error de plan, no una tarea `hard`.
- Si una dependencia es solo de lectura, el implementer puede leerla sin
  esperar; si es de contrato (API, esquema, tipo), debe esperar.

## 5. Modelo y asignación

- `assignee: "orchestrator"` para `hard`, seguridad, arquitectura, conflictos,
  migraciones y tareas ambiguas.
- `assignee: "implementer"` para tareas acotadas con archivos propios.
- El modelo del implementer se puede fijar por tarea con `model`; si no, se usa
  el default del agente.
- Los revisores se eligen por familia, no por precio: nunca la misma familia que
  el autor. La regla vive en `tools/factory/routing.ts`.
- Kimi K2.7 no entra en el ruteo normal; solo escalado manual para bugs o
  arquitectura compleja.

## 6. Criterio de aceptación

Antes de crear o delegar una tarea, comprueba que el criterio:

- describe un resultado observable, no una actividad;
- se puede verificar con un comando, un test, un diff o una inspección concreta;
- incluye el caso negativo o de borde cuando aplica;
- no depende de "que se vea bien".

Si no puedes escribir la evidencia esperada, la tarea aún no está lista.

## 7. Salida del triaje

Para cada tarea devuelve:

```text
key · phase · dificultad (motivo) · assignee · modelo
files_owned · parallelizable · depends_on · risk_flags
criterio verificable · evidencia esperada · dudas
```

Y la ola propuesta: qué tareas pueden ejecutarse a la vez y cuáles esperan.
