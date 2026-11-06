---
name: Factory Quality Gates
description: Cómo usar run_gates, interpretar baseline/política, cobertura, seguridad offline y skips.
metadata:
  opencode/autoinvoke: false
---
# Compuertas de calidad

## Orden

`format → lint → typecheck → build → test → coverage → security → dependencies → static → e2e → accessibility → api → migrations → mutation/performance`

Las lentas (`mutation`, `performance`) solo con `include_slow: true`.

## Estados

- `pass`: la compuerta se ejecutó y pasó.
- `fail`: se ejecutó y encontró fallos o incumplió un umbral.
- `skipped`: no se ejecutó. **Siempre lleva `skipped_reason`; nunca cuenta como pass.**
- `error`: la herramienta falló, timeout o no se pudo parsear.

`run_gates` global:
- `pass`: ninguna compuerta bloqueante falló ni quedó skipped.
- `incomplete`: alguna compuerta bloqueante aplicable quedó skipped.
- `fail`: hay fallo/error bloqueante.

## Línea base

- En onboarding: `run_gates({ mode: "baseline" })`. Guarda fingerprints y cobertura en el perfil.
- En tareas: `run_gates({ mode: "check", task_id, iteration })`.
- Solo los hallazgos **nuevos** bloquean. La deuda previa se reporta con `debt`.
- Una compuerta que ya fallaba/skipped en baseline y sigue igual es deuda, no un fallo nuevo.
- No borres la baseline para "arreglar" una compuerta; si cambias el alcance, vuelve a ejecutar baseline y explica por qué.

## Política

Defaults: build, lint, typecheck, test, secretos y vulnerabilidades críticas/altas bloquean; el resto avisa. Cobertura es advertencia salvo que el proyecto la active.

Para cambiarla:
1. Pide confirmación explícita al usuario.
2. Solo entonces usa `quality_policy_set({ policy, confirmed: true })`.
3. Registra el cambio en el informe.

## Cobertura

- Total y cambiada; umbral configurable (`quality.coverage` / `policy.coverage`).
- Regresión frente a baseline: falla si baja más de `tolerance`.
- Formatos: lcov, Cobertura, Istanbul/JSON, salida de `node --test --experimental-test-coverage`.
- `changedCommand` sirve para medir archivos/líneas cambiadas cuando el stack no genera un reporte por línea.
- PHP sin Xdebug/PCOV: `skipped` con razón; no se inventa cobertura.

## Seguridad

- `mode: "offline"` por defecto: packs Semgrep vendorizados + reglas locales, gitleaks, OSV/Trivy con caché.
- `mode: "online"` solo si el usuario lo autoriza; reporta `network`.
- Bloquean crítico/alto y secretos; medio/bajo se reportan como advertencia según política.
- Si todos los escáneres están `missing`/`skipped`, la compuerta es `skipped`; no es un pass.

## Skips

Un skip bloqueante impide cerrar (`task_close`). Opciones:
- instalar/configurar la herramienta,
- cambiar la política con confirmación,
- registrar un waiver explícito en `task_close` con motivo.

Nunca ocultes un skip en el informe.
