---
name: Factory Deployment
description: Procedimiento de release, despliegue y rollback con compuertas, health checks, migraciones seguras, aprobación humana y evidencia. Úsala cuando haya que preparar o ejecutar un despliegue.
metadata:
  opencode/autoinvoke: false
---
# Despliegue y rollback

Objetivo: desplegar sin sorpresas y poder volver atrás. La fábrica prepara,
verifica y documenta; el humano aprueba producción.

## 1. Entradas

- Perfil del proyecto y comandos verificados (`project_profile_get`).
- Último `run_gates` en verde y `security_scan` sin bloqueantes.
- Diff/release que se va a desplegar y versión (semver o commit).
- Entornos: dev, staging, producción; URLs y health checks.
- Variables y secretos: dónde viven, quién los gestiona, cómo se rotan.
- Migraciones y plan de rollback de datos.
- Runbook existente o borrador del `devops-engineer`.

Si falta el plan de rollback o el health check, no hay despliegue.

## 2. Preflight

1. Ejecuta `run_gates` sobre la rama/release. Un `skipped` no es un `pass`.
2. Ejecuta `security_scan` en modo offline; si hace falta red, decláralo.
3. Revisa migraciones: reversibles, con backup y ventana de mantenimiento.
4. Verifica que no hay secretos en el diff ni en la configuración.
5. Comprueba versiones fijadas (imágenes, dependencias, acciones CI).
6. Define el health check y el smoke test exactos.
7. Define el rollback: comando, versión anterior, migración inversa y datos.
8. Comprueba que el entorno de staging está disponible y es equivalente.

## 3. Build y staging

- Prepara el artefacto con el comando real del proyecto (`docker build`, `npm run build`, etc.).
- Despliega primero en staging; nunca empieces por producción.
- Ejecuta health check y smoke test en staging.
- Prueba el rollback en staging. Si el rollback no se probó, no está listo.
- Registra comandos, versiones, resultados y tiempos.

## 4. Producción

**Requiere aprobación humana explícita.** No la asumas por una aprobación anterior de la tarea.

Antes de pedirla, presenta:

```text
Release: <versión/commit>
Cambios: <resumen y riesgos>
Compuertas: <pass/fail/skipped>
Staging: <health/smoke/rollback>
Migraciones: <ninguna | reversible con backup>
Ventana: <fecha/hora y duración estimada>
Rollback: <comando y versión anterior>
Responsable: <humano>
```

Después de la aprobación:

1. Anuncia el inicio y la ventana.
2. Haz backup si hay migraciones o datos.
3. Despliega la versión aprobada.
4. Ejecuta health check y smoke test.
5. Vigila errores, latencia y logs durante la ventana acordada.
6. Si falla: rollback inmediato; no "arregles" en producción sin aprobación.

## 5. Rollback

Un rollback no es un fracaso: es una compuerta. Debe ser:

- **Rápido:** comando único o runbook claro.
- **Probado:** al menos en staging.
- **Completo:** aplicación, configuración, migraciones y datos.
- **Registrado:** motivo, versión, comando, resultado y estado final.

Si la migración no es reversible, el rollback exige restaurar backup y aceptar la pérdida de datos de la ventana. Eso se aprueba antes, no después.

## 6. Evidencia de despliegue

```text
Release: <versión/commit>
Entorno: <staging | producción>
Aprobación: <quién, cuándo, referencia>
Compuertas: <comando → resultado>
Health check: <comando/URL → resultado>
Smoke test: <comando → resultado>
Migraciones: <ninguna | aplicadas | revertidas>
Rollback probado: <sí/no, comando y resultado>
Incidencias: <ninguna | lista>
Estado real: <desplegado | revertido | bloqueado>
```

## 7. Reglas duras

- No hay despliegue a producción sin aprobación humana explícita.
- No hay `git push`, deploy ni merge a rama protegida automático.
- No hay migración destructiva sin backup y plan de restauración.
- No hay secretos en archivos, logs, prompts ni reportes.
- No hay `@latest` ni versiones flotantes en imágenes o CI.
- Un health check fallido se trata como fallo, no como "warning".
- El rollback se prueba antes de necesitarlo.
- Si falta una herramienta o un entorno, se dice; no se simula el despliegue.
