---
name: Factory Memory
description: Política de memoria viva por entidad, upsert seguro, consolidación dry-run con backup y verificación. Úsala antes de guardar o consolidar memoria.
metadata:
  opencode/autoinvoke: false
---
# Memoria viva

La memoria es una base de conocimiento viva, no un diario. Guarda lo que seguirá
siendo útil en sesiones futuras. No guardes lo que se deriva del código, de git,
de la conversación o de una salida de comando.

## 1. Entidades y cardinalidad

| Tipo | Cardinalidad | Contenido |
|---|---|---|
| `project:<slug>` | UNA por proyecto | Resumen, Stack, Estado actual, Decisiones, Pendientes, Historial de cambios con fecha |
| `preference:<tema>` | UNA por tema | Idioma, estilo, herramientas, entorno |
| `decision:<slug>` | Una por decisión | Contexto, decisión, alternativas, consecuencias |
| `lesson:<slug>` | Una por aprendizaje | Error, causa, solución reutilizable |

## 2. Antes de escribir

En este orden:

1. Identifica la entidad: ¿de qué proyecto o tema habla?
2. Llama a `memory_search` con el nombre de la entidad y una descripción del
   contenido. Lee los resultados.
3. Decide **una** acción:
   - **NOOP**: ya está registrado con el mismo sentido.
   - **UPDATE**: la entidad existe. Usa `memory_upsert` con su `entity_key`.
     Modifica solo la sección afectada. Si un dato nuevo contradice uno anterior,
     el nuevo sustituye al viejo y el viejo pasa al historial con fecha y motivo.
   - **CREATE**: solo si no existe ninguna entidad equivalente.
4. Nunca crees una memoria nueva porque el usuario dijo «cambió» o «ahora». Un
   cambio sobre una entidad conocida es **UPDATE**.
5. Si dudas entre dos candidatas, elige la más específica y menciona la otra en
   `related`.

Cada memoria debe poder leerse sola y tener `last_verified_at`.

## 3. Qué no guardar

- Contenido temporal de la sesión o de la conversación.
- Salidas de comandos, logs o resultados que se pueden volver a ejecutar.
- Código que ya está en el repo, rutas obvias o estructura derivable.
- Secretos, claves, tokens, contraseñas o datos personales sensibles.
- Preferencias que el usuario no ha confirmado.

## 4. Upsert

`memory_upsert` acepta:

```json
{
  "entity_key": "project:mi-proyecto",
  "scope": "project",
  "kind": "convention",
  "title": "Mi proyecto",
  "sections": {
    "Resumen": "...",
    "Stack": "...",
    "Estado actual": "...",
    "Decisiones": "...",
    "Pendientes": "..."
  },
  "tags": ["..."],
  "importance": 3,
  "related": ["decision:..."],
  "reason": "por qué cambia",
  "last_verified_at": "2026-11-14T00:00:00Z"
}
```

La tool busca por `entity_key`, decide NOOP/UPDATE/CREATE, conserva secciones no
tocadas, añade el historial y regenera el embedding. Si el contenido no cambió,
devuelve `noop`. Si hay un candidato parecido sin `entity_key`, lo devuelve en
`candidates`; no lo fusiones a ciegas.

## 5. Consolidación

Cuando haya memorias duplicadas o antiguas:

1. `memory_backup`: copia JSON en `~/.config/opencode/backups/` y fila en
   `memory_backups`.
2. `memory_consolidation_plan`: dry-run; agrupa por entidad, propone
   `merged_content`, `dropped_facts`, `conflicts` y `confidence`. No escribe.
3. Presenta el plan al usuario. Los clusters con `confidence < 0.7` o
   `conflicts` requieren aprobación humana explícita.
4. `memory_consolidation_apply` con `confirmed=true` y, si aplica,
   `approve_low_confidence=true`. Hace backup, upsert del documento, soft delete
   de originales con `merged_into`, fila en el execution log y verificación.
5. `memory_consolidation_verify` con 5-10 consultas reales. Comprueba que la
   información sigue apareciendo.

Nunca borres físicamente memorias originales: usa `deleted_at` y `merged_into`.
Si no puedes decidir cuál es la vigente, no decidas: baja `confidence` y pide
aprobación.

## 6. Consolidación por LLM

El agente `memory-consolidator` recibe un grupo de memorias y devuelve **solo**
este JSON, sin ejecutar cambios:

```json
{
  "clusters": [{
    "entity_key": "project:slug | preference:tema | decision:slug | lesson:slug",
    "action": "merge | keep_separate | archive",
    "source_ids": ["..."],
    "merged_content": "documento consolidado con las secciones de la política",
    "dropped_facts": [{"fact": "...", "reason": "duplicado|obsoleto|trivial|derivable"}],
    "conflicts": [{"old": "...", "new": "...", "resolution": "..."}],
    "confidence": 0.0
  }]
}
```

Reglas del consolidador:

- Fusiona solo la misma entidad; ordena por secciones y conserva fechas.
- Ante contradicción, prevalece la más reciente; la anterior va al historial. Si
  no puedes saber cuál es la vigente, ponlo en `conflicts` con confianza baja.
- No inventes hechos ni rellenes huecos.
- Elimina solo duplicados exactos, datos triviales o derivables del código.
- Si dos memorias parecen distintas aunque se parezcan, `keep_separate`.
