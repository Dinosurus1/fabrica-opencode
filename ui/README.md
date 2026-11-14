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

El navegador nunca recibe la contraseña de OpenCode. El servidor de la consola
lee `OPENCODE_PASSWORD` o `~/.config/opencode/service.json` y añade la cabecera
`Authorization: Basic` al proxy `/api`. La consola escucha solo en `127.0.0.1`
por defecto.

Variables:

| Variable | Default | Uso |
|---|---|---|
| `OPENCODE_URL` | `http://127.0.0.1:49374` | URL del servidor de OpenCode. |
| `OPENCODE_PASSWORD` | leída de `service.json` | Contraseña Basic auth. |
| `FACTORY_UI_PORT` | `4173` | Puerto de la consola. |
| `FACTORY_UI_HOST` | `127.0.0.1` | Interfaz de escucha. |

No publiques la consola en `0.0.0.0` sin poner delante autenticación y TLS.

## Módulos

| Ruta | Qué muestra |
|---|---|
| `/` | Estado general, sesiones, steps, coste, uso por modelo y actividad reciente. |
| `/sessions` | Todas las sesiones de OpenCode (hasta 500); abrir, cambiar agente/modelo, prompt e interrumpir. |
| `/work` | Tareas, planes, gates, revisiones, presupuesto global y execution log. |
| `/agents` | Selección de agentes por proyecto, modo manual/híbrido/auto y modelo activo. |
| `/models` | Catálogo real, perfiles, política y asignación de modelo/presupuesto por rol. |
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
- **Aplicar**: transforma los agentes de la location seleccionada. Exige
  confirmación y queda en `factory_audit_events`.
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

## Limitaciones conocidas

- El coste de OpenCode puede aparecer como `$0` si el proveedor no lo reporta;
  Analytics usa el coste de catálogo de subtasks/reviews.
- La búsqueda de Memory es textual (`ILIKE`); la búsqueda semántica sigue en el
  chat con `memory_search`.
- La consolidación de Memory es una propuesta determinista del plan; el agente
  `memory-consolidator` puede revisarla, pero la UI no aplica nada sin backup y
  confirmación. Los clusters con conflictos o confianza baja exigen una casilla
  de aprobación explícita.
- Configuración, permisos y proveedores son de solo lectura en esta etapa.
- El bundle inicial supera los 500 KB por Recharts; se puede dividir por rutas
  cuando haga falta.
- La UI no edita archivos de configuración ni hace push/deploy.
