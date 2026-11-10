# Plan de reescritura del commit de skills

Fecha: 2026-11-10. **Ejecutado.** La historia quedó en un solo commit sobre
`e5256cb`; el hash final es el HEAD de `factory/orchestration-v2`.

## Estado actual

- Rama: `factory/orchestration-v2`.
- HEAD: `a41c1fa` (`feat: orquestación por fases con worktrees y revisión`).
- Base: `e5256cb` (`Initial release`).
- El commit `a41c1fa` contiene **440 archivos** de skills importadas y 2
  archivos de `docs/skills-import/` que no deben quedar en el historial.
- Las skills locales ya están en
  `~/.local/share/opencode/skills-local/anthropic/` (19 directorios, 13 MB).
- El índice ya tiene preparadas las eliminaciones (`git rm --cached`), pero
  **la historia no se ha reescrito**.

## Respaldo

```text
backups/orchestration-rewrite-20261110.bundle
SHA-1 del bundle verificado; contiene:
  a41c1fa refs/heads/factory/orchestration-v2
  e5256cb refs/heads/main
  e5256cb refs/remotes/origin/HEAD
  e5256cb refs/remotes/origin/main
```

Verificación: `git bundle verify backups/orchestration-rewrite-20261110.bundle`.

## Pasos propuestos

```bash
cd ~/.config/opencode

# 1. Mover HEAD a la base sin tocar el árbol de trabajo ni el índice.
git reset --soft HEAD~1

# 2. Añadir los cambios de documentación y configuración.
git add .gitignore README.md SECURITY.md THIRD-PARTY.md \
        docs/skills-import.md docs/validation-stage-d.md \
        docs/plan-review-rules.md docs/skills-rewrite-plan.md \
        docs/orchestration.md plugins/factory/README.md \
        tools/factory/phase.ts

# 3. Crear el commit limpio, sin skills importadas.
git commit -m "feat: orquestación por fases con worktrees y revisión"

# 4. Eliminar la referencia de recuperación y podar el commit antiguo.
rm -f .git/ORIG_HEAD
git reflog expire --expire=now --all
git gc --prune=now
```

## Resultado esperado

- `git log --oneline -2` muestra `e5256cb` + un commit nuevo.
- `git ls-files skills` solo devuelve `skills/factory-*`.
- `git log --all -- skills/anthropic-docx` no devuelve nada.
- `git cat-file -e a41c1fa` falla (el commit antiguo ya no existe).
- `git status` queda limpio.
- `docs/skills-import.md` y `THIRD-PARTY.md` describen las licencias reales y
  la política local.

## Resultado real

- `git log --oneline e5256cb..HEAD`: un solo commit.
- `git ls-files skills | grep -v factory`: vacío.
- `git log --all -- skills/anthropic-docx`: vacío.
- `git rev-list --all --objects | grep -i anthropic`: vacío.
- `git cat-file -e a41c1fa`: falla; el commit viejo fue podado.
- `gitleaks git`: 0 hallazgos.
- `gitleaks dir` sobre `git archive HEAD`: 0 hallazgos.
- `git status`: limpio.

## Deshacer

Si algo sale mal, el bundle permite recuperar la historia anterior:

```bash
cd /tmp
git clone ~/.config/opencode/backups/orchestration-rewrite-20261110.bundle restore
# o, sobre el repo actual:
git fetch ~/.config/opencode/backups/orchestration-rewrite-20261110.bundle \
  factory/orchestration-v2
```

No se hace push ni se cambia la visibilidad del repositorio.

## Qué queda fuera del repo

- `docx`, `pdf`, `pptx`, `xlsx`: source-available, no redistribuibles.
- `doc-coauthoring`: sin licencia.
- Las 14 skills Apache-2.0 restantes: no se versionan por decisión de alcance;
  la fábrica no las usa. Candidata opcional: `webapp-testing`.
- `docs/skills-import/README.md` y `THIRD_PARTY_NOTICES.md` del repo original.
