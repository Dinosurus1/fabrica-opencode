# Cambios locales en `opencode-memory`

`plugins/opencode-memory/` está excluido del repositorio a propósito
(ver `THIRD-PARTY.md`): la copia local no declara autor ni licencia
verificable. Los siguientes cambios se aplican solo en esta máquina y deben
reaplicarse si se reinstala el plugin.

## 1. Presupuesto de inyección

`plugins/opencode-memory/memory.ts` → `formatMemoryBlock`:

- Cada memoria se recorta a **1.200 caracteres**.
- El bloque completo se limita a **~8.000 caracteres**.
- Las memorias que no caben se resumen en una línea
  `(N memoria(s) omitida(s) por presupuesto de contexto)`.
- Las memorias fijadas conservan la prioridad porque llegan primero.

## 2. Alcance de la búsqueda

`plugins/opencode-memory/memory.ts` → `MemoryStore.search`:

- Proyecto actual: todas las memorias del proyecto.
- Global: solo `preference` y `convention`.
- Los hechos y decisiones globales de otros proyectos dejan de inyectarse.

## 3. Filtro de privacidad

`plugins/opencode-memory/memory.ts` → `looksLikeSecret`:

- Rechaza hosts concretos `*.ts.net`, correos e IPs privadas
  (RFC1918 y CGNAT `100.64.0.0/10`).
- No bloquea `127.0.0.1` ni el patrón genérico `*.ts.net`.
- El mismo filtro está en `tools/factory/types.ts` para `memory_upsert`.

## Cómo verificar

```bash
plugins/opencode-memory/node_modules/.bin/tsx -e '
import { formatMemoryBlock, looksLikeSecret } from "./plugins/opencode-memory/memory.ts";
console.log(looksLikeSecret("mi-host.ejemplo.ts.net")); // true
console.log(looksLikeSecret("*.ts.net")); // false
console.log(looksLikeSecret("127.0.0.1")); // false
'
```

El bloque de prueba debe quedar por debajo de 8.000 caracteres y marcar las
memorias omitidas.
