---
name: Factory Git Safety
description: Reglas de ramas y commits de la fábrica; cómo usar git_branch/git_commit y evitar commitear en ramas protegidas.
metadata:
  opencode/autoinvoke: false
---
# Seguridad git

## Reglas

- `main`, `master` y `develop` están protegidas. Tampoco commitees en ramas que el perfil marque como protegidas.
- Cada tarea vive en una rama `factory/<slug>`.
- Usa `git_branch` para crear/cambiar la rama.
- Usa `git_commit` para stagear y commitear. Es el único camino permitido.
- No uses `git add` ni `git commit` por shell. Las reglas de permisos los deniegan, incluidos `git -c`, `sh -c`, `bash -c` y `commit-tree`.
- `git push`, deploy y operaciones destructivas requieren confirmación explícita.
- `task_close` también rechaza cerrar una tarea en una rama protegida.

## Flujo

1. `git_branch({ task_id })` o `git_branch({ name: "factory/<slug>" })`.
2. Implementa y verifica.
3. `git_commit({ message: "feat: ...", files: ["ruta"] })`. Si omites `files`, solo se stagean archivos ya trackeados.
4. Si estás en una rama protegida, `git_commit` falla; crea la rama primero.
5. Si un commit quedó en la rama equivocada y no se ha pusheado, detente y pide instrucciones; no reescribas historia sin confirmación.

## Mensajes

Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`. Imperativo, corto, con alcance cuando aporte. No incluyas secretos.
