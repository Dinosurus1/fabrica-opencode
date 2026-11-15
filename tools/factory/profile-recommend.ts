/**
 * Recomendación determinística de perfil de ejecución según el proyecto.
 *
 * No usa un LLM: lee una muestra acotada del árbol de archivos y puntúa los
 * perfiles predeterminados. Nunca aplica nada; solo sugiere.
 */

import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { BUILTIN_PROFILE_NAMES } from "./profile-templates.js";

const MAX_FILES = 700;
const MAX_DEPTH = 3;

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".cache",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "worktrees",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".kts",
  ".php",
  ".rb",
  ".cs",
  ".fs",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".swift",
  ".lua",
  ".ex",
  ".exs",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".nix",
  ".sql",
]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".pdf", ".docx", ".odt"]);
const SHELL_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".fish"]);

const STUDY_PATTERN = /(apunte|nota|estudio|universidad|examen|curso|tutorial|guia|resumen|tesis|monografia)/i;

export interface ProjectSignals {
  root: string;
  files: number;
  codeFiles: number;
  docFiles: number;
  testFiles: number;
  shellFiles: number;
  monorepo: boolean;
  hasCode: boolean;
  hasTests: boolean;
  linuxSignals: string[];
  studySignals: string[];
  docs: string[];
}

export interface ProfileRecommendation {
  recommended: string;
  confidence: number;
  scores: Record<string, number>;
  reasons: string[];
  alternatives: Array<{ name: string; score: number }>;
  signals: Omit<ProjectSignals, "docs"> & { docs: string[] };
}

interface WalkState {
  files: number;
  codeFiles: number;
  docFiles: number;
  testFiles: number;
  shellFiles: number;
  linuxSignals: Set<string>;
  studySignals: Set<string>;
  docs: string[];
  topEntries: Set<string>;
}

async function walk(root: string, state: WalkState, dir = root, depth = 0): Promise<void> {
  if (state.files >= MAX_FILES || depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.files >= MAX_FILES) return;
    const name = entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(name) || name.startsWith(".next")) continue;
      if (depth === 0) state.topEntries.add(name);
      await walk(root, state, join(dir, name), depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (depth === 0) state.topEntries.add(name);
    state.files += 1;
    const extension = extname(name).toLowerCase();
    const lower = name.toLowerCase();
    if (CODE_EXTENSIONS.has(extension)) state.codeFiles += 1;
    if (DOC_EXTENSIONS.has(extension)) {
      state.docFiles += 1;
      if (state.docs.length < 8 && (extension === ".md" || extension === ".mdx" || extension === ".pdf")) {
        state.docs.push(name);
      }
    }
    if (SHELL_EXTENSIONS.has(extension)) state.shellFiles += 1;
    if (/(^|[._-])(test|spec)([._-]|$)/i.test(name) || name.includes("__tests__")) {
      state.testFiles += 1;
    }
    if (
      name === "PKGBUILD" ||
      name.endsWith(".service") ||
      name === "configuration.nix" ||
      name === "ansible.cfg" ||
      name === "Dockerfile" ||
      /^docker-compose.*\.ya?ml$/i.test(name) ||
      /^playbook.*\.ya?ml$/i.test(name)
    ) {
      state.linuxSignals.add(name);
    }
    if (STUDY_PATTERN.test(name) || (extension === ".pdf" && state.docFiles > 0)) {
      state.studySignals.add(name);
    }
  }
}

async function readPackageWorkspaces(root: string): Promise<boolean> {
  try {
    const raw = await readFile(join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { workspaces?: unknown };
    return Array.isArray(parsed.workspaces) || Boolean(parsed.workspaces);
  } catch {
    return false;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export async function scanProjectSignals(root: string): Promise<ProjectSignals> {
  const state: WalkState = {
    files: 0,
    codeFiles: 0,
    docFiles: 0,
    testFiles: 0,
    shellFiles: 0,
    linuxSignals: new Set(),
    studySignals: new Set(),
    docs: [],
    topEntries: new Set(),
  };
  await walk(root, state);

  const entries = state.topEntries;
  const workspaces = await readPackageWorkspaces(root);
  const monorepo =
    workspaces ||
    ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json", "go.work"].some((file) =>
      entries.has(file),
    ) ||
    ["packages", "apps", "crates", "services"].some((dir) => entries.has(dir));

  if (entries.has("systemd") || entries.has("etc") || entries.has("nixos")) {
    state.linuxSignals.add("directorio de sistema");
  }

  return {
    root,
    files: state.files,
    codeFiles: state.codeFiles,
    docFiles: state.docFiles,
    testFiles: state.testFiles,
    shellFiles: state.shellFiles,
    monorepo,
    hasCode: state.codeFiles > 0,
    hasTests: state.testFiles > 0,
    linuxSignals: [...state.linuxSignals].slice(0, 10),
    studySignals: [...state.studySignals].slice(0, 10),
    docs: state.docs,
  };
}

export function scoreProfiles(signals: ProjectSignals): {
  scores: Record<string, number>;
  reasons: string[];
} {
  const scores: Record<string, number> = Object.fromEntries(
    BUILTIN_PROFILE_NAMES.map((name) => [name, 0]),
  );
  const reasons: string[] = [];
  const add = (name: string, value: number) => {
    scores[name] = (scores[name] ?? 0) + value;
  };

  if (!signals.hasCode) {
    add("Preguntas básicas", 3);
    add("Estudiar", signals.docFiles > 0 ? 1 : 0);
    reasons.push("no se detectaron archivos de código");
  } else {
    add("Programación básica", 1);
    add("Proyectos pequeños y medianos", 2);
    reasons.push(`${signals.codeFiles} archivos de código`);
  }

  if (signals.monorepo) {
    add("Proyecto grande", 4);
    reasons.push("estructura de monorepo detectada");
  } else if (signals.codeFiles >= 150) {
    add("Proyecto grande", 4);
    reasons.push("repositorio grande (150+ archivos de código)");
  } else if (signals.codeFiles >= 40) {
    add("Proyecto grande", 1);
    add("Proyectos pequeños y medianos", 1);
    reasons.push("tamaño de proyecto mediano-grande");
  } else if (signals.codeFiles <= 10 && signals.hasCode) {
    add("Programación básica", 2);
    reasons.push("pocos archivos de código");
  }

  if (signals.hasTests) {
    add("Proyectos pequeños y medianos", 0.5);
    add("Proyecto grande", 0.5);
    reasons.push("hay tests automatizados");
  }

  if (signals.linuxSignals.length >= 2) {
    add("Linux", 4 + Math.min(2, signals.linuxSignals.length - 2));
    reasons.push(`señales Linux: ${signals.linuxSignals.slice(0, 3).join(", ")}`);
  } else if (signals.shellFiles >= 3) {
    add("Linux", 2);
    reasons.push(`${signals.shellFiles} scripts de shell`);
  }

  if (signals.studySignals.length >= 2 || (signals.docFiles >= 3 && signals.codeFiles <= 5)) {
    add("Estudiar", 4);
    reasons.push(`material de estudio: ${signals.studySignals.slice(0, 3).join(", ") || "documentación"}`);
  } else if (signals.docFiles >= 10) {
    add("Estudiar", 1);
  }

  if (signals.docFiles >= 10 && signals.codeFiles >= 100) {
    add("Proyecto grande", 1);
    reasons.push("mucha documentación junto a un código extenso");
  }

  return { scores, reasons };
}

export function recommendFromSignals(signals: ProjectSignals): ProfileRecommendation {
  const { scores, reasons } = scoreProfiles(signals);
  const ranked = Object.entries(scores)
    .map(([name, score]) => ({ name, score }))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  const top = ranked[0] ?? { name: "Preguntas básicas", score: 0 };
  const second = ranked[1] ?? { name: "", score: 0 };
  const total = ranked.reduce((sum, item) => sum + item.score, 0);
  const margin = total > 0 ? (top.score - second.score) / total : 0;
  const confidence = clamp(0.55 + margin * 0.9 + (top.score >= 4 ? 0.1 : 0), 0.55, 0.95);

  if (top.score === 0) {
    reasons.push("sin señales fuertes; se elige el perfil más barato y seguro");
  }

  return {
    recommended: top.name,
    confidence: Math.round(confidence * 100) / 100,
    scores,
    reasons,
    alternatives: ranked.slice(1, 4),
    signals,
  };
}

export async function recommendProfile(root: string): Promise<ProfileRecommendation> {
  const signals = await scanProjectSignals(root);
  return recommendFromSignals(signals);
}
