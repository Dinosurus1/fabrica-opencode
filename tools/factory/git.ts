/**
 * Tools de seguridad git.
 *
 * Qué hacen:
 *  - git_branch: crea o reutiliza una rama de tarea `factory/<slug>`; rechaza
 *    ramas protegidas.
 *  - git_commit: verifica la rama, valida rutas, stagea y commitea. Nunca
 *    commitea en main/master/develop ni en las ramas protegidas del perfil.
 *
 * Qué acceden: el repositorio git del proyecto y la tabla `factory_projects`
 * (para leer ramas protegidas). Ejecutan git con el usuario del proceso. El
 * commit interno usa la acción de permiso `git.commit`; las reglas de shell
 * deniegan `git add`/`git commit` para forzar este camino controlado.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FactoryDb, FactoryProfile, ProjectRef } from "./db.js";
import { runCommand, shellQuote, tail } from "./exec.js";
import { fail, looksLikeSecret, ok, type ToolDef } from "./types.js";

export interface GitToolsDeps {
  db: FactoryDb;
  resolveProject: (sessionID: string) => Promise<ProjectRef>;
  permission: { assert: (input: Record<string, unknown>) => Promise<void> };
}

const DEFAULT_PROTECTED = ["main", "master", "develop"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "task";
}

export function getProtectedBranches(profile: FactoryProfile | null): string[] {
  const git = isPlainObject(profile?.conventions?.git) ? profile.conventions.git : {};
  const configured = Array.isArray(git.protectedBranches)
    ? git.protectedBranches.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
  return [...new Set([...DEFAULT_PROTECTED, ...configured.map((value) => value.trim())])];
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const result = await runCommand("git rev-parse --abbrev-ref HEAD", cwd, 15_000);
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

export async function getChangedFiles(cwd: string): Promise<string[]> {
  const [changed, untracked, tracked] = await Promise.all([
    runCommand("git diff --name-only HEAD --", cwd, 15_000),
    runCommand("git ls-files --others --exclude-standard", cwd, 15_000),
    runCommand("git ls-files", cwd, 15_000),
  ]);
  const lines = [
    ...(changed.exitCode === 0 ? changed.stdout.split(/\r?\n/) : []),
    ...(untracked.exitCode === 0 ? untracked.stdout.split(/\r?\n/) : []),
    ...(changed.exitCode !== 0 && tracked.exitCode === 0 ? tracked.stdout.split(/\r?\n/) : []),
  ];
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const result = await runCommand(`git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`, cwd, 15_000);
  return result.exitCode === 0;
}

async function switchToBranch(
  deps: GitToolsDeps,
  project: ProjectRef,
  branch: string,
  context: { sessionID: string; agent: string; messageID: string; id: string },
  create: boolean,
  base?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const command = create
    ? `git switch -c ${shellQuote(branch)}${base ? ` ${shellQuote(base)}` : ""}`
    : `git switch ${shellQuote(branch)}`;
  await deps.permission.assert({
    sessionID: String(context.sessionID),
    agent: context.agent,
    source: { type: "tool", messageID: String(context.messageID), id: String(context.id) },
    action: "shell",
    resources: [command],
    save: [command],
    metadata: { tool: "git_branch" },
  });
  const result = await runCommand(command, project.directory, 30_000);
  if (result.exitCode !== 0) {
    return { ok: false, error: tail(result.stderr || result.stdout || "git switch falló", 500) };
  }
  return { ok: true };
}

export function createGitTools(deps: GitToolsDeps): ToolDef[] {
  return [
    {
      name: "git_branch",
      description:
        "Crea o reutiliza una rama de tarea no protegida; si estás en una protegida, crea factory/<slug>.",
      input: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120, description: "Nombre de rama, p. ej. factory/fix-login." },
          task_id: { type: "string", description: "Tarea para generar factory/<slug> si falta name." },
          base: { type: "string", description: "Rama base opcional." },
        },
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const profile = await deps.db.getProfile(project.projectId);
        const protectedBranches = getProtectedBranches(profile);
        const current = await getCurrentBranch(project.directory);
        if (!current) return fail("No se pudo determinar la rama actual; ¿es un repositorio git?");

        let target = typeof input.name === "string" ? input.name.trim() : "";
        if (!target && typeof input.task_id === "string" && UUID_RE.test(input.task_id)) {
          const task = await deps.db.getTask(project.projectId, input.task_id);
          if (task) target = `factory/${slugify(task.title)}`;
        }
        if (!target) {
          if (!protectedBranches.includes(current)) {
            return ok({ branch: current, created: false, protectedBranches });
          }
          return fail("Estás en una rama protegida. Indica `name` o `task_id` para crear una rama de tarea.");
        }
        if (protectedBranches.includes(target)) {
          return fail(`La rama "${target}" está protegida. Usa una rama de tarea no protegida.`);
        }
        if (target === current) {
          return ok({ branch: current, created: false, protectedBranches });
        }

        const exists = await branchExists(project.directory, target);
        const switched = await switchToBranch(deps, project, target, {
          sessionID: String(context.sessionID),
          agent: context.agent,
          messageID: String(context.messageID),
          id: String(context.id),
        }, !exists, typeof input.base === "string" ? input.base.trim() : undefined);
        if (!switched.ok) return fail(switched.error);

        return ok({
          branch: target,
          created: !exists,
          previousBranch: current,
          protectedBranches,
          base: typeof input.base === "string" ? input.base : undefined,
        });
      },
    },
    {
      name: "git_commit",
      description:
        "Stagea y commitea solo en rama no protegida; único camino permitido para commitear.",
      input: {
        type: "object",
        properties: {
          message: { type: "string", minLength: 3, maxLength: 300, description: "Mensaje Conventional Commits." },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Archivos a stagear; si se omite, solo trackeados.",
          },
          branch: {
            type: "string",
            description: "Rama de tarea a crear/usar si estás en una protegida.",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const profile = await deps.db.getProfile(project.projectId);
        const protectedBranches = getProtectedBranches(profile);
        let current = await getCurrentBranch(project.directory);
        if (!current) return fail("No se pudo determinar la rama actual; ¿es un repositorio git?");

        const requestedBranch = typeof input.branch === "string" ? input.branch.trim() : "";
        if (protectedBranches.includes(current)) {
          if (!requestedBranch) {
            return fail(
              `No se puede commitear en "${current}". Crea una rama con git_branch o pasa branch a git_commit (por ejemplo factory/<slug>).`,
            );
          }
          if (protectedBranches.includes(requestedBranch)) {
            return fail(`La rama "${requestedBranch}" está protegida; elige una rama de tarea.`);
          }
          const exists = await branchExists(project.directory, requestedBranch);
          const switched = await switchToBranch(deps, project, requestedBranch, {
            sessionID: String(context.sessionID),
            agent: context.agent,
            messageID: String(context.messageID),
            id: String(context.id),
          }, !exists);
          if (!switched.ok) return fail(switched.error);
          current = requestedBranch;
        } else if (requestedBranch && requestedBranch !== current) {
          if (protectedBranches.includes(requestedBranch)) {
            return fail(`La rama "${requestedBranch}" está protegida; elige una rama de tarea.`);
          }
          const exists = await branchExists(project.directory, requestedBranch);
          const switched = await switchToBranch(deps, project, requestedBranch, {
            sessionID: String(context.sessionID),
            agent: context.agent,
            messageID: String(context.messageID),
            id: String(context.id),
          }, !exists);
          if (!switched.ok) return fail(switched.error);
          current = requestedBranch;
        }

        if (protectedBranches.includes(current)) {
          return fail(`La rama "${current}" está protegida; no se commitea.`);
        }

        const message = String(input.message ?? "").trim();
        if (message.length < 3) return fail("El mensaje de commit es demasiado corto.");
        if (looksLikeSecret(message)) return fail("El mensaje de commit parece contener un secreto. No se commiteó.");

        const filesInput = Array.isArray(input.files) ? input.files : [];
        const files: string[] = [];
        for (const raw of filesInput) {
          if (typeof raw !== "string" || !raw.trim()) return fail("Cada archivo debe ser una ruta no vacía.");
          const absolute = resolve(project.directory, raw.trim());
          if (!inside(project.directory, absolute)) {
            return fail(`La ruta "${raw}" queda fuera del proyecto; no se stagea.`);
          }
          files.push(relative(project.directory, absolute) || raw.trim());
        }

        await deps.permission.assert({
          sessionID: String(context.sessionID),
          agent: context.agent,
          source: { type: "tool", messageID: String(context.messageID), id: String(context.id) },
          action: "git.commit",
          resources: [current],
          save: [],
          metadata: { tool: "git_commit", branch: current, files },
        });

        const addCommand = files.length > 0 ? `git add -- ${files.map(shellQuote).join(" ")}` : "git add -u";
        const addResult = await runCommand(addCommand, project.directory, 60_000);
        if (addResult.exitCode !== 0) {
          return fail(`git add falló: ${tail(addResult.stderr || addResult.stdout, 500)}`);
        }

        const commitResult = await runCommand(`git commit -m ${shellQuote(message)}`, project.directory, 120_000);
        if (commitResult.exitCode !== 0) {
          return fail(`git commit falló: ${tail(commitResult.stderr || commitResult.stdout, 800)}`);
        }

        const hashResult = await runCommand("git rev-parse HEAD", project.directory, 15_000);
        const commit = hashResult.exitCode === 0 ? hashResult.stdout.trim() : null;
        return ok({
          committed: true,
          branch: current,
          commit,
          message,
          staged: files.length > 0 ? files : "tracked-only",
        });
      },
    },
  ];
}
