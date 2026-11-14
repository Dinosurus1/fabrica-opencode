# Contexto global

- Responde en español, salvo que el usuario pida otro idioma.
- Commits con Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`), en imperativo y con alcance cuando aporte.
- Honestidad: no afirmes que algo funciona si no lo ejecutaste; distingue "verificado" de "esperado".
- Nunca imprimas ni guardes secretos, tokens, contraseñas ni cadenas de conexión completas; usa variables de entorno.
- No hagas push, deploy ni operaciones destructivas sin confirmación explícita.

## Context7

- Úsalo para documentación actual de librerías, frameworks, SDKs, APIs, configuración y migraciones. No para refactor, debug general o conceptos que no dependen de una librería.
- Resuelve el ID de la librería, elige la mejor coincidencia y consulta un concepto por llamada. Responde con la documentación obtenida y cita la fuente.

## Delegación

- Imagen adjunta: mírala directamente; si está en un archivo, usa `read`. Transcribe el texto literal; si algo es ilegible, dilo.
- Documentación de librerías: Context7. Información cambiante fuera de la documentación oficial: `@researcher`.
- Explorar el repo: `read`/`grep`/`glob` o `@explore`; no copies archivos enteros al chat.
- Tareas independientes: subagentes en paralelo y quédate con el resumen. Tras cambios visibles de frontend, haz screenshot con Playwright y revísalo con `read`.

## Fábrica de software

- Para proyectos, fases o funcionalidades nuevas, usa el agente `factory` y carga `factory-pipeline` antes de planificar.
- Activa `product-analyst`, `architect` y `tech-writer` solo cuando la etapa lo requiera; cada uno tiene un entregable verificable y no duplica responsabilidades.
- La fuente de verdad de tareas, compuertas y revisiones es PostgreSQL; `docs/` guarda especificaciones, arquitectura y runbooks. La carta de gobierno está en `docs/factory-charter.md`.
- La consola web vive en `ui/`; consume el API de OpenCode y el RPC de la fábrica. No es una fuente de verdad ni sustituye las compuertas.
- Toda entrega exige evidencia y validación independiente; push, deploy, migraciones destructivas y cambios de alcance requieren confirmación humana.

## Memoria persistente

- La memoria vectorial se inyecta sola cuando es relevante. En tareas largas o si el usuario alude al pasado, usa `memory_search`.
- Guarda con `memory_save` lo durable: preferencias, decisiones, convenciones, entorno y soluciones reutilizables. Usa `scope: "global"` para lo transversal y `project` para el repo actual.
- No guardes secretos ni información efímera. No dupliques: corrige o borra lo obsoleto con `memory_forget`. Si una memoria contradice el código, gana el código.
- La captura automática analiza la sesión al quedar inactiva; no hace falta resumir la conversación al final.
