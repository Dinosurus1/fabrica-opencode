# Skills de `anthropics/skills` (locales, no versionadas)

Fecha: 2026-11-09, actualizado: 2026-11-10.
Origen: `skills-main.zip` (`anthropics/skills`, commit
`2c5958ecac7cee2b583967a2c4981d0f4a75c579`).

## Política actual

- Las **19 skills importadas no se versionan** en este repositorio.
- El repo solo conserva las skills propias `factory-*`.
- Las importadas quedan en disco, fuera del índice de git, para uso local.
- La opción recomendada es moverlas a
  `~/.local/share/opencode/skills-local/anthropic/`, fuera de
  `~/.config/opencode/skills/`, para que OpenCode no las anuncie ni las cargue
  por defecto.
- Si quieres una skill concreta, se copia o enlaza de vuelta a `skills/` y se
  decide explícitamente si se versiona.

**Ninguna skill importada es necesaria para que la fábrica funcione.** La única
candidata razonable si se quiere conservar una es `webapp-testing` (Apache-2.0),
por su afinidad con la verificación de interfaces; no se usa desde el código de
la fábrica.

## Licencias reales

| Skill | ID local | Licencia / archivo | ¿Redistribuible? |
|---|---|---|---|
| `academy-guide` | `academy-guide` | Apache-2.0 (`LICENSE.txt`, Anthropic) | Sí |
| `algorithmic-art` | `algorithmic-art` | Apache-2.0 (`LICENSE.txt`, Anthropic) | Sí |
| `brand-guidelines` | `brand-guidelines` | Apache-2.0 (`LICENSE.txt`, Anthropic) | Sí |
| `canvas-design` | `canvas-design` | Apache-2.0 (`LICENSE.txt`, Anthropic) | Sí |
| `claude-api` | `claude-api` | Apache-2.0 (`LICENSE.txt`, Anthropic) | Sí |
| `discernment-nudge` | `discernment-nudge` | Apache-2.0 (`LICENSE.txt`, Anthropic) | Sí |
| `doc-coauthoring` | `doc-coauthoring` | **Sin `LICENSE.txt`** | **No** |
| `docx` | `anthropic-docx` | **Source-available**; el `LICENSE.txt` del zip contiene texto Apache-2.0, pero el titular la declara no redistribuible | **No** |
| `frontend-design` | `frontend-design` | Apache-2.0 (`LICENSE.txt`, sin apéndice) | Sí |
| `internal-comms` | `internal-comms` | Apache-2.0 (`LICENSE.txt`, Anthropic) | Sí |
| `mcp-builder` | `mcp-builder` | Apache-2.0 (`LICENSE.txt`, Anthropic) | Sí |
| `pdf` | `anthropic-pdf` | **Source-available**; mismo caso que `docx` | **No** |
| `pptx` | `anthropic-pptx` | **Source-available**; mismo caso que `docx` | **No** |
| `skill-creator` | `anthropic-skill-creator` | Apache-2.0 (`LICENSE.txt`, Anthropic) | Sí |
| `slack-gif-creator` | `slack-gif-creator` | Apache-2.0 (`LICENSE.txt`, Anthropic) | Sí |
| `theme-factory` | `theme-factory` | Apache-2.0 (`LICENSE.txt`, Anthropic) | Sí |
| `web-artifacts-builder` | `web-artifacts-builder` | Apache-2.0 (`LICENSE.txt`, Anthropic) | Sí |
| `webapp-testing` | `webapp-testing` | Apache-2.0 (`LICENSE.txt`, Anthropic) | Sí |
| `xlsx` | `anthropic-xlsx` | **Source-available**; mismo caso que `docx` | **No** |

Notas:

- `docx`, `pdf`, `pptx` y `xlsx` se tratan como **source-available / no
  redistribuibles** por indicación del titular. Aunque el `LICENSE.txt` incluido
  en el zip reproduce el texto de Apache-2.0, no se usan like Apache para
  redistribución.
- `doc-coauthoring` no trae licencia; sin permiso explícito, no se redistribuye.
- Las 14 skills Apache-2.0 conservan su `LICENSE.txt` con copyright de
  Anthropic. Si se versiona alguna en el futuro, hay que conservar ese archivo y
  la atribución.
- `THIRD-PARTY.md` es la fuente canónica de atribuciones del repo. Este
  documento es la guía operativa de las skills locales.

## Qué se saca del repositorio

Se eliminan del índice y del historial:

- `skills/anthropic-docx/`
- `skills/anthropic-pdf/`
- `skills/anthropic-pptx/`
- `skills/anthropic-xlsx/`
- las demás skills importadas, si no se decide conservar alguna;
- las copias `docs/skills-import/README.md` y
  `docs/skills-import/THIRD_PARTY_NOTICES.md` del repositorio original.

Los directorios locales se conservan en disco y se añaden a `.gitignore` para
que no vuelvan a entrar por accidente.

## Peso en tokens de las descripciones visibles

Medición con `tiktoken` (`o200k_base` y `cl100k_base`; ambos coinciden en este
caso). Es una aproximación: el modelo real puede tokenizar distinto.

| Momento | Skills visibles de la configuración | Tokens de descripciones | Bloque `<available_skills>` completo |
|---|---:|---:|---:|
| Antes de importar | 0 (las 10 `factory-*` tienen `opencode/autoinvoke: false`) | 0 | 0 |
| Después de importar | 7 (`algorithmic-art`, `canvas-design`, `frontend-design`, `mcp-builder`, `slack-gif-creator`, `theme-factory`, `webapp-testing`) | 341 | 580 |
| Si se conserva solo `webapp-testing` | 1 | 31 | ~60 |
| Si se mueven todas fuera de `skills/` | 0 | 0 | 0 |

El aumento por la importación es de **+341 tokens** de descripciones, o **+580
tokens** si se cuenta el bloque completo con etiquetas. Las skills ocultas no
suman porque no se anuncian.

## Dependencias declaradas (no instaladas)

| Skill | Dependencias |
|---|---|
| `algorithmic-art` | p5.js vía CDN y navegador. |
| `canvas-design` | Fuentes incluidas; generación de PDF/PNG. |
| `anthropic-docx` | `docx` (npm), `pandoc`, LibreOffice, `pdftoppm`. |
| `anthropic-pdf` | `pypdf`, `pdf2image`, `pytesseract` (OCR opcional). |
| `anthropic-pptx` | `pptxgenjs`, `react-icons`, `react`, `react-dom`, `sharp`, LibreOffice, `pdftoppm`. |
| `anthropic-xlsx` | `openpyxl`, `pandas`, `markitdown`, LibreOffice. |
| `webapp-testing` | Python + Playwright. |
| `slack-gif-creator` | `Pillow`, `imageio`, `numpy`. |
| `mcp-builder` | Node/TypeScript o Python según el servidor. |

La importación no instala nada. Si falta una dependencia, se dice y se propone
la instalación; no se simula.

## Cómo usar una skill local

Si se conserva en `~/.local/share/opencode/skills-local/anthropic/`, no se
anuncia automáticamente. Para usarla:

1. Copia o enlaza su carpeta a `~/.config/opencode/skills/<id>/`.
2. Recarga OpenCode.
3. Invócala con `@<id>` o con la tool `skill`.

No vuelvas a versionarla sin revisar su licencia y sin actualizar
`THIRD-PARTY.md`.

## Verificación

- `gitleaks dir` sobre el zip extraído: **0 hallazgos**.
- 18 de las 19 skills traen `LICENSE.txt`; `doc-coauthoring` no.
- Las cuatro de documentos se tratan como restringidas.
- No hay IDs duplicados con las skills integradas de OpenCode: las conflictivas
  se renombraron a `anthropic-*`.
- Tras la limpieza, `git ls-files skills` solo debe devolver `factory-*`.
