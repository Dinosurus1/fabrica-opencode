## Qué cambia

## Cómo se verificó

- [ ] `cd ui && npm run check` (tsc + Vitest + build)
- [ ] `cd ui && npm run test:e2e` (si toca flujos de consola)
- [ ] `cd plugins/factory && ./node_modules/.bin/tsc -p tsconfig.json` (si toca la fábrica)
- [ ] Probado en móvil (390×844) si hay cambios visibles
- [ ] Sin secretos en el diff, en logs ni en el bundle
- [ ] Rutas mutables siguen exigiendo sesión y `x-factory-ui`
- [ ] Documentación/runbook actualizado si cambia el arranque o el acceso

## Riesgos y rollback

<!-- Qué puede romperse y cómo se revierte. -->
