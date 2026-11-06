# Terceros y atribuciones

Este repositorio contiene configuración, agentes, skills y código propio bajo
licencia MIT (ver `LICENSE`). No incluye `node_modules`, binarios de escáneres,
packs de Semgrep ni plugins de terceros.

## Dependencias directas del plugin

Instaladas por `npm ci` desde `plugins/factory/package.json`; no se redistribuyen
en el repositorio.

| Paquete | Versión | Licencia | Uso |
|---|---|---|---|
| `@opencode/plugin` | 2.2.5 | MIT | API de plugins de OpenCode. |
| `pg` | ^8.16.3 | MIT | Cliente PostgreSQL. |
| `typescript` | ^5.9.3 | Apache-2.0 | Compilación y comprobación de tipos (dev). |
| `@types/node` | ^24.10.1 | MIT | Tipos de Node.js (dev). |
| `@types/pg` | ^8.15.6 | MIT | Tipos de `pg` (dev). |

Las dependencias transitivas se resuelven desde npm y conservan sus propias
licencias; `package-lock.json` solo fija versiones y no contiene su código.

## Herramientas externas que la fábrica invoca

No se distribuyen con este repositorio. Se usan como binarios del sistema.

| Herramienta | Licencia | Enlace |
|---|---|---|
| OpenCode V2 | MIT | <https://github.com/anomalyco/opencode> |
| Semgrep CLI | LGPL-2.1 | <https://github.com/semgrep/semgrep> |
| Gitleaks | MIT | <https://github.com/gitleaks/gitleaks> |
| OSV-Scanner | Apache-2.0 | <https://github.com/google/osv-scanner> |
| Trivy | Apache-2.0 | <https://github.com/aquasecurity/trivy> |
| PostgreSQL | PostgreSQL License | <https://www.postgresql.org/about/licence/> |
| pgvector | PostgreSQL License | <https://github.com/pgvector/pgvector> |

## Packs de Semgrep

No se incluyen. `scripts/fetch-semgrep-packs.sh` los descarga desde
`semgrep.dev` en tiempo de instalación. Cada pack declara:

```text
license: Semgrep Rules License v1.0
https://semgrep.dev/legal/rules-license
```

No se redistribuyen para evitar dudas sobre esa licencia. La ruta
`plugins/factory/rules/packs/` está en `.gitignore`.

## opencode-memory

No se incluye. La copia local no declara autor, licencia ni atribución
verificable. Existe un paquete npm homónimo `opencode-memory` con licencia MIT
(autor `tomako`, <https://github.com/shuans/opencode-memory>), pero no se pudo
confirmar que la copia local sea esa distribución. Si se incorpora en el futuro,
hay que fijar versión, conservar su `LICENSE` y documentar los cambios locales.

## Marcas y documentación

Los nombres de productos y marcas citados pertenecen a sus titulares. La
documentación enlazada se usa solo como referencia; no se copia en el
repositorio.
