# Revisión de `Factory-update` (paquete V1 → fábrica global V2)

> Fecha: 2026-11-13. Alcance: `AGENTS.md`, `opencode.json`, `software-factory.zip`
> y los 11 agentes del paquete. No se copió el paquete tal cual: se absorbió lo
> que aportaba y se rechazó lo que duplicaba o contradecía la fábrica global.

## Qué era el paquete

Una **plantilla de proyecto** con:

- `AGENTS.md` (prompt maestro de ~13 KB).
- `opencode.json` con plugin, MCP, tools y permisos.
- `.opencode/agents/` con 11 roles.
- `.factory/*.json` como tablero de tareas, compuertas y deuda.
- Una skill `quality-gates` y un `setup.sh`.

No era una actualización de la fábrica global (`~/.config/opencode`), sino una
versión paralela y anterior del mismo concepto.

## Compatibilidad con OpenCode V2

V2 mantiene compatibilidad con la configuración V1, así que el paquete **carga**,
pero no es V2 nativo:

| Elemento | V1 en el paquete | V2 nativo |
|---|---|---|
| Plugins | `plugin` | `plugins` |
| MCP | `mcp.<nombre>` + `enabled` | `mcp.servers.<nombre>` + `disabled` |
| Permisos | `permission` + `bash` | `permissions` con `action: "shell"` |
| Tools por agente | `tools: { "x_*": false }` | reglas `permissions` con `action: "x_*"` |
| Agentes | `permission`, `temperature`, `tools`, `task` | `permissions`, `steps`; la temperatura va en la variante del modelo |
| Comandos | `subtask` | `subagent` |

Los ficheros de agente con frontmatter V1 se traducen automáticamente, pero
generan avisos y mezclar V1/V2 en un mismo fichero hace que se ignoren campos.

## Bloqueos reales encontrados

1. **Modelos inexistentes.** Los agentes usan `anthropic/claude-*`; en esta
   instalación no hay proveedor `anthropic`. Los modelos equivalentes están en
   `opencode/` y `opencode-go/`. Tal cual, los agentes no arrancarían con su
   modelo configurado.
2. **Placeholder sin completar.** `AGENTS.md` §5.1 dice «Pega aquí tus 16 reglas
   originales». El documento está incompleto.
3. **Reproducibilidad.** `@playwright/mcp@latest` y `npx -y` sin versión fija
   violan la regla A8 del propio paquete. `sequential-thinking` añade contexto y
   es prescindible con modelos que ya razonan.
4. **Duplicación de estado.** `.factory/task-state.json` y
   `.factory/quality-gates.json` duplican el tablero y las compuertas que la
   fábrica global ya guarda en PostgreSQL (`tasks`, `gate_runs`, `review_runs`,
   `plans`).
5. **Permisos globales frágiles.** `tools.*: false` global + `tools.*: true` por
   agente es un patrón V1; en V2 conviene expresarlo con reglas ordenadas y
   `deny` explícito.
6. **`setup.sh` sin pin.** Clona `anthropics/skills` sin fijar commit ni revisar
   licencias; la fábrica global ya tiene su política en `docs/skills-import.md`.

## Qué se absorbió

- **Carta de gobierno** en `docs/factory-charter.md`: misión, principios, capas,
  pipeline, roles, presupuestos, aprobaciones humanas y evaluación de modelos.
- **Skill `factory-pipeline`**: clasificación de la entrada, activación bajo
  demanda de roles y compuertas por entregable.
- **Tres roles nuevos**:
  - `product-analyst`: escribe `docs/requirements.md`, no decide arquitectura.
  - `architect`: escribe `docs/architecture.md` y ADR, no implementa.
  - `tech-writer`: escribe README/CHANGELOG/runbooks, no cambia especificaciones.
- **Formato de evidencia** enriquecido: estado real, regresiones, decisiones y
  versiones/comandos, además del informe de `factory-closure-report`.
- **Tres modos de trabajo** (automático, manual e híbrido) como base del futuro
  módulo de gestión de agentes y modelos.

## Qué se rechazó y por qué

| Elemento | Decisión |
|---|---|
| `.factory/task-state.json` como fuente de verdad | Rechazado: la fuente es PostgreSQL. Un export legible es posible como artefacto derivado, no como tablero paralelo. |
| Segunda skill `quality-gates` | Rechazada: ya existe `factory-quality-gates` y `run_gates`. |
| 8 agentes de implementación especializados | Rechazados por ahora: el modo por fases usa un `implementer` genérico con `files_owned` y worktrees; fragmentarlo exige cambiar `subtask_run`. Se puede añadir después con ruteo por rol. |
| `setup.sh` con clone sin pin | Rechazado: reproducibilidad y licencias. |
| MCP `sequential-thinking` | Rechazado: coste de contexto sin ventaja clara. |
| `default_agent: orchestrator` | Rechazado: la fábrica global usa `factory`; dos orquestadores compiten. |

## Implementado después de la revisión

- **Model & Agent Management (MAM)**: catálogo sincronizado, perfiles de
  ejecución, asignación bloqueada por rol, listas de permitidos/prohibidos,
  validación de capacidades y contexto, auditoría y persistencia del perfil
  aplicado por location.
- **RPC de la fábrica** en `/api/rpc/opencode.factory/*` para catálogo, perfiles,
  trabajo, memoria y analítica.
- **Consola web** en `ui/` (React/Vite) con Overview, Sessions, Work, Agents,
  Models, Memory, Projects, Skills, Analytics y Settings. Proxy autenticado en
  `127.0.0.1:4173`.
- **Modos de trabajo** `auto`, `manual` y `hybrid` guardados en el perfil.
- **Selección de agentes** por proyecto (manual/híbrido/auto) aplicada como
  reglas `subagent` de la sesión.
- **Presupuestos** global/fase/tarea con reserva atómica y liquidación al
  terminar; `max_tokens` como límite principal.
- **Execution log** con inicio/fin, modelo, modo, motivo, tokens, coste, estado,
  intento, error, versiones y gate; alimenta Analytics y la evaluación de modelos.
- **Skills acotadas por agente** con reglas `skill` V2.

## Pendiente / siguiente iteración

- Selección automática/manual/híbrida de agentes con recomendación del
  orquestador y aprobación humana.
- Edición controlada de configuración, permisos y proveedores desde la UI.
- Export opcional de estado a `.factory/` para proyectos que quieran versionar
  evidencia sin depender de PostgreSQL.
- Convertir el zip en plantilla V2 autónoma solo si se necesita portabilidad
  fuera de la fábrica global.
