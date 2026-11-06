/**
 * Punto de entrada de las tools de la fábrica.
 *
 * Qué hace: recibe las dependencias (base de datos, resolución de proyecto y
 * permisos) y devuelve las definiciones de tools que el plugin registra.
 *
 * Qué accede: nada por sí mismo; cada tool declara sus propios accesos.
 */

import { createChecksTools } from "./checks.js";
import { createDoctorTools, type DoctorDeps } from "./doctor.js";
import { createGatesTools } from "./gates.js";
import { createGitTools } from "./git.js";
import { createProjectTools } from "./project.js";
import { createReviewTools } from "./reviews.js";
import { createSecurityTools } from "./security.js";
import { createTaskTools } from "./tasks.js";
import type { FactoryDb, ProjectRef } from "./db.js";
import type { ToolDef } from "./types.js";
import type { UsageDeps } from "./usage.js";

export interface FactoryToolDeps {
  db: FactoryDb;
  resolveProject: (sessionID: string) => Promise<ProjectRef>;
  permission: { assert: (input: Record<string, unknown>) => Promise<void> };
  diagnostics: DoctorDeps["diagnostics"];
  usage: UsageDeps;
}

export function createFactoryTools(deps: FactoryToolDeps): ToolDef[] {
  return [
    ...createProjectTools(deps),
    ...createTaskTools(deps),
    ...createChecksTools(deps),
    ...createSecurityTools(deps),
    ...createGitTools(deps),
    ...createGatesTools(deps),
    ...createReviewTools({ ...deps, ...deps.usage }),
    ...createDoctorTools(deps),
  ];
}

export type { FactoryDb, ProjectRef, ToolDef };
