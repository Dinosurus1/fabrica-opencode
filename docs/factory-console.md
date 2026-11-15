# Factory Console — Fase 0, Fase 1 y Fase 2

Fecha: 2026-11-15. Ámbito: `ui/` y `scripts/`.

Este documento describe lo implementado de las fases 0, 1 y 2 del mapa de
mejoras, el modelo de amenaza y lo que queda pendiente.

## Fase 0 — Calidad y seguridad base

### Autenticación propia

- Login en `/` con contraseña y cookie de sesión `factory_session` (HttpOnly,
  SameSite=Lax, Secure si llega `X-Forwarded-Proto: https`).
- La cookie es un token firmado con HMAC-SHA256; caducidad configurable
  (`FACTORY_UI_SESSION_TTL`, 7 días por defecto).
- Contraseña: `FACTORY_UI_PASSWORD` o, como respaldo local, la de
  `~/.config/opencode/service.json`.
- El servicio systemd carga `ui/.env.local` (ignorado por git). Para generar una
  contraseña aleatoria:
  ```bash
  ./scripts/factory-set-password.sh
  cat ui/.env.local
  ```
- `/auth/session` y `/auth/logout` completan el ciclo. La UI vuelve al login si
  una petición recibe 401.

### Rate limit

- Login: 10 intentos / 5 minutos por IP; responde 429 con `Retry-After`.
- Rutas mutables de `/api/*`: 120 peticiones / minuto por IP.
- Todas las mutaciones exigen `x-factory-ui: 1` y un `Origin` coherente con el
  `Host` (defensa CSRF). Los GET no se limitan para no romper SSE.

### Cabeceras y contrato

- `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy` y `Permissions-Policy` en todas las respuestas.
- `ui/src/lib/http.ts`: errores `HttpError` y `ContractError`, timeout,
  reintentos solo en GET/HEAD y validación opcional con Zod (`lib/schemas.ts`).
- `ErrorBoundary` global y por ruta; `Transcript` conserva su estado de error.

### Arranque

- `factory-ui.service` (systemd de usuario) sirve la consola con
  `Restart=always`.
- Al arrancar, el servidor comprueba OpenCode y lo levanta con
  `opencode serve --service` si no responde.
- Botón «Encender» en la cabecera cuando `/healthz` falla.
- `POST /api/system/start` (autenticado y con cabecera) fuerza el arranque.
- `~/.config/autostart/factory-console.desktop` abre la página al iniciar la
  sesión gráfica.
- Instalación idempotente:
  ```bash
  ./scripts/install-factory-autostart.sh
  ```

### Pruebas

```bash
cd ui
npm run check          # tsc + vitest + build
npm run test:e2e       # build + Playwright (servidor propio en :4174)
```

- Vitest: utilidades de formato, cliente HTTP (reintentos, 401, timeout,
  contrato), SSE con `EventSource` simulado (apertura, reconexión y limpieza),
  agrupación de turnos, `Transcript`, `SessionList` y adjuntos.
- Playwright: login obligatorio y persistente, crear chat, cambiar de sesión,
  conservar borrador y adjunto tras recargar, borrar chat y navegación móvil.
- El E2E usa el Chromium del sistema (`PLAYWRIGHT_CHROMIUM`) y no descarga
  navegadores.
- Resultado actual: 51 pruebas unitarias/componente y 4 E2E en verde.

## Fase 1 — Móvil, PWA y acceso remoto

- `manifest.webmanifest` con iconos 192/512 y `display: standalone`.
- `apple-touch-icon`, `theme-color`, `viewport-fit=cover`,
  `apple-mobile-web-app-*`.
- Service worker: shell offline (`/offline.html`), caché de estáticos y
  navegación con fallback. Nunca cachea `/api`, `/auth` ni `/healthz`.
- Safe areas (`env(safe-area-inset-*)`) en cabecera, contenido y navegación
  inferior.
- `visualViewport` mantiene `--app-height`; el compositor y la lista de sesiones
  se encogen con el teclado en iOS.
- Navegación inferior de 5 accesos en móvil, controles de 44 px y gesto de
  borde para abrir/cerrar el menú lateral.
- Borradores en `localStorage` y adjuntos pendientes en IndexedDB por sesión
  (7 días, limpieza automática).
- Restauración de scroll por sesión en `Transcript`.
- Aviso de «sin conexión» y pantalla offline clara.

### Tailscale

La consola escucha solo en `127.0.0.1`. Se publica en la tailnet en
**https://<equipo>.<tailnet>.ts.net:8443/**; el 443 sigue siendo el Funnel del
host principal.

```bash
# Una vez, para no ejecutar serve como root:
sudo tailscale set --operator=$USER

# Estado / publicar / retirar:
./scripts/factory-tailscale.sh status
./scripts/factory-tailscale.sh enable
./scripts/factory-tailscale.sh disable
```

### Acceso desde el móvil

1. Instala Tailscale en el móvil e inicia sesión con la misma cuenta de la
   tailnet. Deja la VPN conectada.
2. Abre **https://<equipo>.<tailnet>.ts.net:8443/**.
3. Introduce la contraseña de la consola. En el PC:
   ```bash
   cat ~/.config/opencode/ui/.env.local
   ```
   También puedes fijar una contraseña que recuerdes:
   ```bash
   ./scripts/factory-set-password.sh --ask
   ```
4. Para instalarla como app:
   - Android/Chrome: menú → «Instalar aplicación» o «Añadir a pantalla de inicio».
   - iOS/Safari: compartir → «Añadir a pantalla de inicio».
5. Si el móvil pierde la VPN, verás la pantalla de «Sin conexión»; reconecta
   Tailscale y reintenta.

La URL solo responde dentro de la tailnet. No se ha tocado el Funnel del host
principal.

ACL recomendada (ejemplo, adaptar a los tags reales):

```jsonc
{
  "grants": [
    {
      "src": ["autogroup:member"],
      "dst": ["tag:factory-console"],
      "ip": ["tcp:8443"]
    }
  ]
}
```

Si no se usan tags, limita el acceso a los dispositivos del propietario y evita
`autogroup:internet`. La consola no debe publicarse con Funnel.

## Fase 2 — Estado y tiempo real

- **Streaming incremental**: `session.text.delta` y `session.reasoning.delta` se
  acumulan en el cliente (`lib/streaming.ts`) y se fusionan con el último
  contexto por `assistantMessageID` y `ordinal`. Ya no se pide el contexto
  completo en cada delta; solo al cerrar un bloque y en estados terminales.
- **Estado por sesión**: `session.status` (`busy`, `retry`, `idle`) actualiza el
  indicador «Trabajando» sin esperar al polling. `session.idle` y los eventos
  terminales limpian el estado y refrescan el contexto.
- **Permisos pendientes**: `permission.asked`/`permission.replied` se muestran
  en el panel de la sesión, en la lista y en un aviso global del Layout. Se
  responde con `once`, `always` o `reject` y motivo opcional.
- **Sincronización entre pestañas**: la sesión abierta y los borradores viajan
  por `localStorage` (`storage`). No se pisan si el usuario está escribiendo en
  la pestaña activa.
- **Reconciliación**: al volver de segundo plano o recuperar la red se
  refrescan sesiones, sesiones activas, contexto y permisos. Las sesiones
  borradas en otra pestaña desaparecen de la lista y no dejan buffers de
  streaming huérfanos.
- **Envío con reintento manual**: si el prompt falla, el texto y los adjuntos
  siguen en el compositor y el error queda visible; no hay cola automática.
- **Adjuntos pendientes** en IndexedDB (7 días) y restauración de scroll por
  sesión, ya cubiertos en Fase 1.

## Modelo de amenaza

- **Sin exposición a Internet**: solo loopback o tailnet. Funnel queda fuera.
- **Robo de cookie**: cookie HttpOnly, SameSite=Lax y Secure en HTTPS; el token
  caduca, incluye una versión de sesión y no se guarda en localStorage. Logout o
  reinicio del servicio invalidan los tokens anteriores. Logout también borra
  borradores y adjuntos locales.
- **Fuerza bruta**: rate limit de login + comparación en tiempo constante +
  retardo de 250 ms.
- **CSRF**: cabecera propia y comprobación de `Origin` en mutaciones.
- **XSS**: CSP sin `unsafe-eval`; React escapa el contenido. El markdown ligero
  no inyecta HTML.
- **Secretos**: no se imprimen; `ui/.env.local` está ignorado y el bundle no
  contiene la contraseña (vive en el servidor).
- **Abuso de recursos**: límite de cuerpo (8 KB) en login, rate limit y
  timeouts de 20 s.

## Pendiente / límites conocidos

- El SSE está cubierto con un `EventSource` simulado en Vitest (apertura,
  reconexión y limpieza); no hay E2E contra un servidor SSE simulado.
- La virtualización de transcripciones y la paginación de sesiones son Fase 3.
- Notificaciones nativas y PWA instalable con prompt (`beforeinstallprompt`) no
  están implementadas.
- `tailscale serve` requiere `sudo tailscale set --operator=$USER` o ejecutar el
  comando con `sudo`; no se automatizó para no tocar el Funnel del host
  principal.
