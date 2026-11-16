# Factory Console

Consola web de gestión de la fábrica de software y de OpenCode V2. No sustituye
la TUI ni la app de OpenCode: es un cliente separado que consume el API del
servidor y el RPC del plugin `opencode.factory`.

## Requisitos

- Node.js 20+.
- OpenCode V2 corriendo (probado con 2.2.5).
- `~/.config/opencode/service.json` con la contraseña del servidor, o
  `OPENCODE_PASSWORD` en el entorno.
- PostgreSQL de la fábrica para Work, Memory, Analytics y MAM.

## Instalación y arranque

```bash
cd ~/.config/opencode/ui
npm ci
npm run build
npm run start
```

O desde la raíz del repo:

```bash
./scripts/factory-ui.sh
```

Abre <http://127.0.0.1:4173>.

Para desarrollo con recarga:

```bash
npm run dev
```

Vite sirve en `127.0.0.1:4173` y proxya `/api` al servidor de OpenCode.

## Autenticación y proxy

La consola tiene login propio con cookie de sesión. El navegador nunca recibe la
contraseña de OpenCode: el servidor lee `OPENCODE_PASSWORD` o
`~/.config/opencode/service.json` y añade `Authorization: Basic` al proxy
`/api`. La consola escucha solo en `127.0.0.1` por defecto.

- `FACTORY_UI_PASSWORD` define la contraseña de la consola; si falta, usa la de
  `service.json`.
- `./scripts/factory-set-password.sh` genera una contraseña local en
  `ui/.env.local` (ignorado por git, modo 600).
- Hay rate limit en login y en rutas mutables, y cabeceras CSP/anti-CSRF.
- `FACTORY_UI_REQUIRE_AUTH=1` obliga login incluso sin contraseña configurada.

Variables:

| Variable | Default | Uso |
|---|---|---|
| `OPENCODE_URL` | `http://127.0.0.1:49374` | URL del servidor de OpenCode. |
| `OPENCODE_PASSWORD` | leída de `service.json` | Contraseña Basic auth del proxy. |
| `FACTORY_UI_PASSWORD` | leída de `service.json` | Contraseña del login de la consola. |
| `FACTORY_UI_SESSION_TTL` | `604800` | Duración de la cookie de sesión (s). |
| `FACTORY_UI_PORT` | `4173` | Puerto de la consola. |
| `FACTORY_UI_HOST` | `127.0.0.1` | Interfaz de escucha. |
| `FACTORY_UI_ALLOWED_HOSTS` | vacío | Hosts extra permitidos (Tailscale). |
| `FACTORY_DB_CONTAINER` | `opencode-memory-db` | Contenedor PostgreSQL que arranca el botón «Encender». |
| `FACTORY_DB_HOST` | `127.0.0.1` | Host de PostgreSQL para la comprobación de salud. |
| `FACTORY_DB_PORT` | `5433` | Puerto de PostgreSQL. |
| `FACTORY_DB_AUTOSTART` | `1` | `0` desactiva el arranque por Docker (base gestionada aparte). |

No publiques la consola en `0.0.0.0`. Para acceso remoto usa Tailscale Serve
(`scripts/factory-tailscale.sh`) y mantén el login activo. Ver
`docs/factory-console.md`.

## Arranque automático

```bash
./scripts/install-factory-autostart.sh
```

Instala `factory-ui.service` (systemd de usuario, `Restart=always`), arranca
PostgreSQL y OpenCode si no están levantados y deja un lanzador XDG que abre la
página al iniciar la sesión gráfica.

## Módulos

| Ruta | Qué muestra |
|---|---|
| `/` | Estado general, sesiones, steps, coste, uso por modelo y actividad reciente. |
| `/sessions` | Sesiones raíz relevantes (sin subagentes ni temporales por defecto) con lista agrupada y búsqueda. Crear, abrir, eliminar (con confirmación), cambiar agente/modelo/perfil, enviar prompts con adjuntos (imágenes, PDFs y documentos), interrumpir, seguir la conversación en tiempo real por SSE y aviso de sesión larga con traspaso a una sesión nueva. Aprueba o rechaza las solicitudes de permiso de herramientas (shell, archivos, web…) que OpenCode deja en pausa, con marca en la lista y aviso global. Conserva el borrador y los adjuntos pendientes de cada conversación, y restaura la última sesión y los filtros al recargar. |
| `/work` | Tareas, planes, gates, revisiones, presupuesto global y execution log. |
| `/agents` | Selección de agentes por proyecto, modo manual/híbrido/auto y modelo activo. |
| `/models` | Catálogo real, perfiles (incluidos los predeterminados), recomendación de perfil por proyecto, política y asignación de modelo/presupuesto por rol. |
| `/memory` | Memoria vectorial: auditoría, búsqueda textual, metadatos, borrado y consolidación dry-run con backup, aprobación, soft delete y verificación. |
| `/projects` | Proyectos conocidos por OpenCode. |
| `/skills` | Skills disponibles y su origen. |
| `/analytics` | Coste de fábrica, uso estimado de todas las sesiones de OpenCode, tool success e historial por modelo/rol. |
| `/settings` | Salud de la fábrica, proveedores, MCP y configuración en solo lectura. |

## Model & Agent Management

- **Perfiles**: agrupaciones reutilizables de `agente → modelo`.
- **Asignación bloqueada**: cada agente usa su modelo; no hay fallback silencioso.
- **Validación previa**: el perfil falla si el modelo no existe, no está activo,
  no está autorizado, está prohibido, no soporta tools o no llega al contexto
  mínimo.
- **Aplicar**: transforma los agentes de la location seleccionada. Desde Models
  exige confirmación; desde Sessions se aplica al elegir el perfil y se refleja
  en el catálogo de agentes. Queda en `factory_audit_events`.
- **Persistencia**: el ID del perfil aplicado se guarda por location en
  `factory_meta`; al recargar el plugin se restaura.
- **Separación**: cambiar el modelo no altera permisos, prompts ni skills.
- **Default ≠ aplicado**: el perfil por defecto es el que se propone; el aplicado
  es el que está en uso en la location. La UI muestra ambos.
- **Política editable**: proveedores/modelos permitidos, modelos prohibidos,
  contexto mínimo y exigencia de tools.
- **Presupuesto**: límites por asignación en Models y presupuesto global en Work;
  la reserva real es atómica en `subtask_run`/`review_run`. La unidad es coste si
  hay precio versionado y tokens ponderados si no. `token_budget` no es un límite
  de salida de la API. Hay aviso al 80 % y el sobreconsumo repetido >1,5x se
  detecta en `factory_doctor`.
- **Modos de modelo**: manual (modelo fijado por rol), auto (código + política +
  historial) e híbrido (auto con aprobación en tareas sensibles o caras).
- **Selección de agentes**: manual, híbrido o auto; se aplica a la sesión como
  reglas `subagent`.
- **Skills acotadas**: los agentes de la fábrica solo ven las skills permitidas
  por sus reglas `skill` (factory-*, context7-mcp y documentos cuando aplica).

## Arquitectura

```text
Factory Console (React/Vite)
  ├── /api/*                    API de OpenCode (sesiones, agentes, modelos, skills, MCP)
  └── /api/rpc/opencode.factory/*  RPC del plugin de la fábrica (MAM, Work, Memory, Analytics)
```

- Las llamadas que dependen de la location envían `location[directory]` con el
  `canonical` del proyecto seleccionado. Sin eso, OpenCode usaría la location
  por defecto.
- La vista de sesiones se suscribe a `/api/event` (SSE) para reflejar mensajes,
  herramientas y estado en tiempo real. Si el filtro de tipos deja de ser válido
  tras actualizar OpenCode, reintenta automáticamente sin filtro.
- El texto y el razonamiento se pintan con los deltas
  (`session.text.delta`, `session.reasoning.delta`) y se fusionan por
  `assistantMessageID`/`ordinal` (`lib/streaming.ts`). El contexto completo solo
  se pide al cerrar el bloque, al terminar la ejecución o al reconciliar.
- La sesión abierta y los borradores se sincronizan entre pestañas por
  `localStorage`; al volver del segundo plano se refrescan sesiones, contexto y
  permisos.
- Los permisos llegan por `permission.asked` y se responden con
  `POST /api/session/:id/permission/:requestId/reply` (`once`, `always`,
  `reject` + motivo opcional). Mientras no se responde, OpenCode mantiene la
  herramienta en pausa y la sesión figura como «running».
- Los formularios llegan por `form.created` y se responden con
  `POST /api/session/:id/form/:formID/reply` (`answer`), o se cancelan con
  `DELETE`. Soportan campos string, number, integer, boolean y multiselect.
- El E2E de red corta 10 s con SSE simulado y verifica que no se duplican ni
  pierden mensajes al reconectar.
- El compositor admite comandos de barra (`/models`, `/agent`, `/status`,
  `/continue`, `/checkpoint`, `/cd`, `/help`). Se ejecutan en el cliente; `/status`
  lee `GET /api/repo/status` (git de solo lectura) y nunca pregunta al modelo.
- La continuación usa un traspaso estructurado con el último pedido completo y
  el estado del repo. El linaje raíz → hija se guarda en `localStorage` durante
  el MVP; no se sincroniza entre dispositivos hasta la etapa 2.
- Los adjuntos se envían como data URI en `files[].uri`; OpenCode los convierte
  en adjuntos inline. El límite de la consola es 6 archivos de 8 MB (20 MB en
  total) por mensaje.
- El estado de la fábrica vive en PostgreSQL; la UI no mantiene un tablero
  paralelo.
- El proxy del servidor Node sirve `dist/` y reenvía `/api` con Basic auth.

## Scripts

| Script | Qué hace |
|---|---|
| `npm run dev` | Vite en desarrollo con proxy. |
| `npm run build` | Typecheck y build de producción en `dist/`. |
| `npm run start` | Sirve `dist/` y proxya `/api` en `127.0.0.1:4173`. |
| `npm run preview` | Preview de Vite (sin proxy de auth). |
| `npm run test` | Vitest (utilidades, HTTP, componentes). |
| `npm run test:e2e` | Build + Playwright (login, chats, borradores, adjuntos). |
| `npm run check` | `tsc` + Vitest + build de producción. |

## Limitaciones conocidas

- El coste de OpenCode puede aparecer como `$0` si el proveedor no lo reporta;
  Analytics usa el coste de catálogo de subtasks/reviews.
- La búsqueda de Memory es textual (`ILIKE`); la búsqueda semántica sigue en el
  chat con `memory_search`.
- La consolidación de Memory es una propuesta determinista del plan; el agente
  `memory-consolidator` puede revisarla, pero la UI no aplica nada sin backup y
  confirmación. Los clusters con conflictos o confianza baja exigen una casilla
  de aprobación explícita.
- La lista de Sessions oculta por defecto subagentes, sesiones sin agente/título y
  directorios temporales (`/tmp` o worktrees). El selector «Subagentes» permite
  verlos para auditoría.
- El aviso de sesión larga usa los tokens acumulados (≥2M) o el contexto del
  último mensaje (≥60 % del límite del modelo). El traspaso es un resumen local
  editable; no se envía nada hasta que el usuario crea la sesión.
- Los permisos de herramientas se responden en caliente (`una vez`, `siempre` o
  `rechazar`). La política de permisos de cada agente sigue siendo de solo
  lectura en esta etapa.
- Configuración y proveedores son de solo lectura en esta etapa.
- El bundle inicial supera los 500 KB por Recharts; se puede dividir por rutas
  cuando haga falta.
- La UI no edita archivos de configuración ni hace push/deploy.
