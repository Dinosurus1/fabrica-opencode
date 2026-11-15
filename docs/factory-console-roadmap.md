# Mapa de mejoras — Factory Console

**Fecha:** 2026-11-14 · **Ámbito:** consola web `ui/` de `~/.config/opencode` · **Estado:** propuesta por fases.

Este documento es la referencia de fases de la consola. Cada fase se implementa
solo cuando la anterior está verificada; las fases 0 y 1 están cerradas y la
fase 2 está en curso. El detalle de lo implementado vive en
`docs/factory-console.md`.

## Punto de partida (2026-11-14)

Hecho:

- Sesiones con lista agrupada, búsqueda, filtros y selección persistente.
- Conversación en tiempo real por SSE, con polling de respaldo.
- Adjuntos de imágenes/documentos, arrastrar y soltar, pegar y previsualizar.
- Borrado de chats con confirmación y borrado en cascada de subagentes.
- Borradores de texto por conversación y adjuntos pendientes.
- Estado «Trabajando» por sesión, no global.
- Markdown ligero, razonamiento plegable, herramientas agrupadas y código con copiar.
- Responsive básico y cabecera móvil compacta.

Falta para uso diario desde cualquier sitio:

- Autenticación propia y exposición segura.
- PWA instalable y pulido de teclado/safe-area.
- Persistencia de adjuntos y scroll entre recargas.
- Virtualización y paginación para sesiones enormes.
- Tests automatizados de UI y de contrato con el API.

## Mapa por fases

| Fase | Tema | Prioridad |
|---|---|---|
| 0 | Calidad y seguridad base | P0 |
| 1 | Móvil, PWA y acceso remoto | P0/P1 |
| 2 | Estado y tiempo real | P1 |
| 3 | Rendimiento | P1 |
| 4 | Producto y UX | P1/P2 |
| 5 | Observabilidad y operación | P2 |
| 6 | Colaboración y multi-equipo | P2 |

## Fase 0 — Calidad y seguridad base (P0)

Objetivo: poder tocar la UI sin miedo y sin exponer la máquina.

- Login propio (cookie de sesión), rate limit en login y rutas mutables.
- Error boundary global y estados de error por página.
- Contrato tipado con el API de OpenCode y validación con Zod.
- Tests unitarios, de componente, E2E y de SSE; CI local y checklist.
- `.env.example` sin secretos; arranque del servidor al abrir la página.

Criterio: build, `tsc` y tests en verde; ninguna ruta mutable sin auth; ningún
secreto en el bundle.

## Fase 1 — Móvil, PWA y acceso remoto (P0/P1)

Objetivo: usarla desde el móvil fuera de casa, con seguridad y sin fricción.

- PWA: manifest, iconos, `display: standalone`, tema, apple-touch-icon.
- Safe areas, `viewport-fit=cover` y compositor que no queda tapado por el teclado.
- Botones de 44 px, navegación inferior y gestos.
- Persistencia de borradores/adjuntos y restauración de scroll.
- Instalación iOS/Android y pantalla de «sin conexión».
- Tailscale Serve + auth propia + ACL, sin tocar el Funnel del host principal.
- Notificaciones opcionales de sesión terminada, error o permiso pendiente.

Criterio: uso real 30 min desde el móvil sin perder estado; Lighthouse móvil
≥ 90 en accesibilidad y rendimiento percibido.

## Fase 2 — Estado y tiempo real (P1)

Objetivo: que el estado sea siempre correcto, aunque haya varias pestañas.

- Streaming incremental por deltas SSE (texto y razonamiento), con merge por
  `messageID`/`partID`, en lugar de refetch completo cada segundo.
- Sincronización entre pestañas (`BroadcastChannel`/`localStorage`): borradores,
  sesión abierta y estado de ejecución.
- Persistencia de adjuntos pendientes en IndexedDB con cuota y limpieza.
- Cola de mensajes si el envío falla; reintento manual.
- Detección de permisos/formularios pendientes y aviso en la lista.
- Reconciliación al volver de segundo plano: resync de sesión y lista.
- Manejo de sesiones borradas/archivadas en otra pestaña.
- Estado real por sesión con `session.status`/`session.idle`.

Criterio: dos pestañas mantienen el mismo estado; matar la red 10 s y recuperar
sin duplicar ni perder mensajes; scroll y borrador sobreviven a recargas.

## Fase 3 — Rendimiento (P1)

Objetivo: sesiones de 200+ mensajes y 1.000+ sesiones sin tirones.

- Virtualizar la transcripción y cargar por tramos.
- Paginación/cursor de sesiones en vez de `limit=500`.
- Cache por sesión y `staleTime` coherente; no refrescar toda la lista por delta.
- Separar el bundle por rutas y revisar chunks > 500 kB.
- Memoizar markdown por mensaje.
- Comprimir imágenes en cliente y avisar del peso.
- Medir con React Profiler; presupuesto LCP/INP.

Criterio: abrir 200 mensajes < 1 s en el PC; scroll a 60 fps; memoria estable;
INP < 200 ms en móvil.

## Fase 4 — Producto y UX (P1/P2)

Objetivo: que la consola sea cómoda, no solo funcional.

- Renombrar, fijar y archivar conversaciones.
- Búsqueda global (título, agente, modelo, contenido si el API lo permite).
- Atajos de teclado y command palette (⌘K).
- Acciones de mensaje: copiar, reintentar, editar/borrar el último, ver diff.
- Visor de adjuntos a pantalla completa.
- Tema claro/oscuro y densidad.
- Filtros guardados; estado vacío con sugerencias.
- Accesibilidad AA e i18n opcional.

## Fase 5 — Observabilidad y operación (P2)

- Health check propio y del proxy a OpenCode.
- Logs estructurados sin prompts ni secretos; correlación por `sessionID`.
- Métricas de latencia, reconexiones SSE, errores y adjuntos.
- Panel «Sistema» con OpenCode, proxy, PostgreSQL y memoria.
- Alertas locales para ejecución fallida o presupuesto.
- Actualización/rollback documentados; backups.
- systemd con `Restart=always`.

## Fase 6 — Colaboración y multi-equipo (P2)

- Multi-usuario con identidad de Tailscale y roles.
- Sesiones compartidas o de solo lectura.
- Separación estricta por proyecto y location.
- Auditoría de acciones y cuotas por usuario/proyecto.
- Vistas de equipo y asignación de tareas.

## Backlog transversal

Exportar a Markdown/PDF, compartir sesión con enlace temporal (solo tailnet),
plantillas de prompt, vista de diff, historial/fork de mensajes, offline de solo
lectura, notificaciones nativas, i18n y moneda configurable.

## Métricas de éxito

| Métrica | Objetivo |
|---|---|
| Primer token en móvil | < 3 s |
| Pérdida de borradores al cambiar de sesión | 0 |
| Reconexión SSE tras cambio de red | < 5 s |
| Sesión de 200 mensajes | scroll fluido, < 1 s |
| Errores de consola en uso normal | 0 |
| Cobertura de flujos críticos | crear, adjuntar, borrar, cambiar sesión |

## Orden recomendado

1. Fase 0 + Fase 1 antes de usar fuera de casa.
2. Fase 2 para estado impecable con varias pestañas.
3. Fase 3 cuando aparezcan sesiones largas o lentitud.
4. Fase 4 incremental, empezando por atajos y renombrar/archivar.
5. Fase 5 antes de dejarlo como servicio permanente.
6. Fase 6 solo si hay más usuarios.

## No objetivos por ahora

- Exponer la consola a Internet sin autenticación.
- Sustituir la TUI o la app oficial de OpenCode.
- Sincronizar sesiones entre tailnets distintas.
- Editar código o gestionar git desde la consola.
- Convertir la consola en una fuente de verdad paralela a PostgreSQL.
