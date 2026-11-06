---
name: Factory Security Review
description: Cuándo y cómo delegar en security-reviewer, qué evidencia pasar y cómo evaluar sus hallazgos.
metadata:
  opencode/autoinvoke: false
---
# Revisión de seguridad

## Cuándo

Invoca a `@security-reviewer` si el cambio toca:

- autenticación, autorización, sesiones o permisos;
- entradas de usuario, SQL, ORM, comandos o plantillas;
- archivos, subidas, rutas, symlinks o descargas;
- red, SSRF, redirects, CORS o CSRF;
- secretos, tokens, criptografía o comparaciones;
- dependencias nuevas o actualizadas.

## Qué pasarle

- El diff completo (o `git diff` si el repo es accesible).
- Rutas de los archivos tocados.
- La salida de `security_scan` (semgrep, gitleaks, osv, trivy) con su modo offline/online.
- El criterio de aceptación de la tarea.

No le pases secretos ni volcados enormes. No le pidas que edite.

## Cómo evaluar su respuesta

- Verifica cada hallazgo contra el código; no lo obedezcas a ciegas.
- Si es falso positivo, explica por qué y descártalo con evidencia.
- Si es válido, crea una tarea o corrige la causa raíz.
- Si es una sospecha, pide la evidencia que falta o conviértela en una comprobación concreta.
- Registra en el informe qué hallazgos aceptaste, refutaste o dejaste abiertos.

## Límites

- El revisor no sustituye a las compuertas deterministas.
- Si los escáneres no están disponibles, dilo: no hay evidencia automatizada.
- No inventes vulnerabilidades para justificar una revisión.
