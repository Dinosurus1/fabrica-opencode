---
name: Factory Onboarding
description: Onboarding de un repositorio para la fábrica: detectar stack, verificar comandos reales, guardar perfil y registrar límites.
metadata:
  opencode/autoinvoke: false
---
# Onboarding de un repositorio

Objetivo: dejar un perfil exacto y verificado antes de tocar código.

## Pasos

1. Ejecuta en paralelo `project_profile_get` y `memory_search` con el nombre o la ruta del repo.
2. Lee `AGENTS.md`, `README*`, `CONTRIBUTING*`, `opencode.json*`, manifiestos y CI. Las instrucciones del repo mandan sobre tus defaults.
3. Ejecuta `project_detect`. Revisa `stack`, `commands`, `quality`, `alternatives`, `stack.tools` y `warnings`.
4. Verifica los comandos reales, no los del README:
   - Usa `run_checks` con `commands` candidatos para probar install/lint/typecheck/test/build sin guardar todavía.
   - Si `run_checks` no cubre un comando (por ejemplo `run` o un script de migración), ejecútalo con shell y revisa la salida.
   - Un comando solo cuenta como verificado si terminó con exit 0 y produjo el efecto esperado.
5. Guarda el perfil con `project_profile_set`:
   - `stack`: lenguajes, frameworks, package manager, tooling, base de datos.
   - `commands`: install, lint, typecheck, test, build, run (solo los que existan).
   - `quality`: comandos candidatos de cobertura, formato, e2e, api, static y migraciones.
   - `conventions`: docs, scripts, ramas protegidas, notas de estilo.
   - `verified: true` solo si ejecutaste y pasaron los comandos principales.
6. Si falta una herramienta o no hay comando, déjalo escrito en `notes`/`warnings` y no lo inventes. Un comando ausente no es un comando verificado.
7. Ejecuta `run_gates({ mode: "baseline" })`. Guarda la línea base en el perfil y revisa qué compuertas quedaron `skipped` o `error`; explícalo antes de empezar a codificar. La deuda previa no bloquea tareas nuevas.
8. No guardes secretos. Usa variables de entorno.

## Notas por stack

- **Node/TS**: respeta el package manager del lockfile. `lint`/`typecheck`/`test` deben ser scripts reales; si usas `npx`, verifica que el binario exista en el proyecto.
- **PHP/Composer**: `composer install`, `composer test`, `vendor/bin/phpunit`, `vendor/bin/phpstan`, `vendor/bin/psalm`, `vendor/bin/pint --test`, `vendor/bin/php-cs-fixer fix --dry-run`. Sin Composer, detecta PHP plano y usa `php -l` sobre archivos cambiados si `php` existe; no inventes PHPUnit si no hay tests.
- **PHP plano/MySQL**: detecta `PDO`/`mysqli`; no ejecutes migraciones ni consultas contra una base real sin autorización. Marca la integración de BD como pendiente si no hay base de prueba.
- **Java Maven**: usa `./mvnw` si existe; si no, `mvn`. Lint solo si hay checkstyle/spotless/PMD configurado. Gradle: `./gradlew` si existe; Kotlin usa `compileKotlin`.
- **Ruby**: `bundle install`, `bundle exec rspec`, `bin/rails test`, `bundle exec rubocop`, `bundle exec srb tc`. Si no hay `bundle`, no ejecutes los comandos como si existieran.
- **.NET**: `dotnet restore`, `dotnet build --no-restore`, `dotnet test --no-build`, `dotnet format --verify-no-changes`; comprueba `dotnet --list-sdks`.
- **Rust/Go**: `cargo`/`go` deben existir; si no, marca la compuerta como no disponible.

## Salida

Devuelve un resumen corto: stack detectado, comandos verificados, comandos que faltan, y si el perfil quedó `verified`.
