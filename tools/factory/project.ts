/**
 * Tools de detección y perfil de proyecto.
 *
 * Qué hacen:
 *  - project_detect: inspecciona manifiestos y documentación del repo y devuelve
 *    stack y comandos candidatos. No ejecuta nada.
 *  - project_profile_get / project_profile_set: leen y guardan el perfil exacto
 *    (comandos verificados, convenciones) en PostgreSQL.
 *
 * Qué acceden: archivos de manifiestos/documentación dentro del proyecto y la
 * tabla `factory_projects`. No leen `.env`, claves ni archivos binarios.
 */

import { accessSync, constants, existsSync } from "node:fs";
import { realpath, readFile, readdir, stat } from "node:fs/promises";
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { FactoryDb, FactoryProfile, ProjectRef } from "./db.js";
import { fail, looksLikeSecret, ok, type ToolDef } from "./types.js";

export interface ProjectToolsDeps {
  db: FactoryDb;
  resolveProject: (sessionID: string) => Promise<ProjectRef>;
}

interface Ecosystem {
  name: string;
  commands: Record<string, string>;
  languages: string[];
  frameworks: string[];
  tooling: string[];
  packageManager?: string;
  evidence: string[];
  warnings: string[];
  conventions?: Record<string, unknown>;
  quality?: Record<string, unknown>;
}

const MANIFEST_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "tsconfig.json",
  "jsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "poetry.lock",
  "Pipfile",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Makefile",
  "justfile",
  "Taskfile.yml",
  "Dockerfile",
  "docker-compose.yml",
  "compose.yml",
  "AGENTS.md",
  "README.md",
  "README",
  "CONTRIBUTING.md",
  "CONTRIBUTING",
  "opencode.json",
  "opencode.jsonc",
  ".editorconfig",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function readText(path: string, maxBytes = 128 * 1024): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return null;
    const text = await readFile(path, "utf8");
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return null;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function hasCommand(name: string): boolean {
  const path = process.env.PATH ?? "";
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {
      // Sigue buscando.
    }
  }
  return false;
}

function toolAvailability(): Record<string, boolean> {
  return {
    node: hasCommand("node"),
    npm: hasCommand("npm"),
    php: hasCommand("php"),
    composer: hasCommand("composer"),
    mvn: hasCommand("mvn"),
    gradle: hasCommand("gradle"),
    bundle: hasCommand("bundle"),
    ruby: hasCommand("ruby"),
    dotnet: hasCommand("dotnet"),
    go: hasCommand("go"),
    cargo: hasCommand("cargo"),
  };
}

async function collectFiles(
  root: string,
  extension: string,
  maxFiles = 40,
  depth = 0,
): Promise<string[]> {
  if (depth > 2) return [];
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (found.length >= maxFiles) break;
    if (entry.name === "node_modules" || entry.name === "vendor" || entry.name === ".git" || entry.name.startsWith(".")) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(extension)) {
      found.push(path);
    } else if (entry.isDirectory()) {
      found.push(...(await collectFiles(path, extension, maxFiles - found.length, depth + 1)));
    }
  }
  return found.slice(0, maxFiles);
}

async function readSome(root: string, extension: string): Promise<string> {
  const files = await collectFiles(root, extension);
  const parts: string[] = [];
  for (const file of files.slice(0, 20)) {
    const text = await readText(file, 16 * 1024);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function scriptCommand(packageManager: string, script: string): string {
  switch (packageManager) {
    case "pnpm":
      return `pnpm ${script}`;
    case "yarn":
      return `yarn ${script}`;
    case "bun":
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

function installCommand(packageManager: string, entries: string[]): string {
  switch (packageManager) {
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "yarn":
      return "yarn install --frozen-lockfile";
    case "bun":
      return "bun install";
    default:
      return entries.includes("package-lock.json") ? "npm ci" : "npm install";
  }
}

async function detectNode(root: string, entries: string[]): Promise<Ecosystem | null> {
  const raw = await readText(join(root, "package.json"));
  if (!raw) return null;

  const warnings: string[] = [];
  let pkg: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isPlainObject(parsed)) pkg = parsed;
  } catch {
    warnings.push("package.json no es JSON válido; revisa el manifiesto.");
  }

  const dependencies: Record<string, unknown> = {
    ...(isPlainObject(pkg.dependencies) ? pkg.dependencies : {}),
    ...(isPlainObject(pkg.devDependencies) ? pkg.devDependencies : {}),
    ...(isPlainObject(pkg.peerDependencies) ? pkg.peerDependencies : {}),
    ...(isPlainObject(pkg.optionalDependencies) ? pkg.optionalDependencies : {}),
  };
  const has = (name: string) => Object.prototype.hasOwnProperty.call(dependencies, name);
  const scripts = isPlainObject(pkg.scripts) ? pkg.scripts : {};

  const frameworks: string[] = [];
  for (const [dependency, label] of [
    ["next", "Next.js"],
    ["nuxt", "Nuxt"],
    ["@sveltejs/kit", "SvelteKit"],
    ["svelte", "Svelte"],
    ["vue", "Vue"],
    ["react", "React"],
    ["express", "Express"],
    ["fastify", "Fastify"],
    ["@nestjs/core", "NestJS"],
    ["vite", "Vite"],
    ["astro", "Astro"],
    ["@remix-run/node", "Remix"],
    ["electron", "Electron"],
    ["expo", "Expo"],
  ] as const) {
    if (has(dependency)) frameworks.push(label);
  }

  const tooling: string[] = [];
  for (const [dependency, label] of [
    ["typescript", "TypeScript"],
    ["eslint", "ESLint"],
    ["@biomejs/biome", "Biome"],
    ["prettier", "Prettier"],
    ["vitest", "Vitest"],
    ["jest", "Jest"],
    ["mocha", "Mocha"],
    ["@playwright/test", "Playwright"],
    ["cypress", "Cypress"],
    ["prisma", "Prisma"],
    ["drizzle-orm", "Drizzle"],
    ["typeorm", "TypeORM"],
    ["sequelize", "Sequelize"],
  ] as const) {
    if (has(dependency)) tooling.push(label);
  }

  let packageManager = "npm";
  if (entries.includes("pnpm-lock.yaml")) packageManager = "pnpm";
  else if (entries.includes("yarn.lock")) packageManager = "yarn";
  else if (entries.includes("bun.lock") || entries.includes("bun.lockb")) packageManager = "bun";
  else if (entries.includes("package-lock.json")) packageManager = "npm";
  else if (typeof pkg.packageManager === "string") {
    packageManager = pkg.packageManager.split("@")[0] || "npm";
  }

  const commands: Record<string, string> = {
    install: installCommand(packageManager, entries),
  };
  if (typeof scripts.lint === "string") commands.lint = scriptCommand(packageManager, "lint");
  if (typeof scripts.typecheck === "string") commands.typecheck = scriptCommand(packageManager, "typecheck");
  else if (typeof scripts["type-check"] === "string") commands.typecheck = scriptCommand(packageManager, "type-check");
  else if (typeof scripts.types === "string") commands.typecheck = scriptCommand(packageManager, "types");
  if (typeof scripts.test === "string") commands.test = scriptCommand(packageManager, "test");
  if (typeof scripts.build === "string") commands.build = scriptCommand(packageManager, "build");
  if (typeof scripts.dev === "string") commands.run = scriptCommand(packageManager, "dev");
  else if (typeof scripts.start === "string") commands.run = scriptCommand(packageManager, "start");

  const hasTsconfig = entries.includes("tsconfig.json");
  if (!commands.lint && (has("eslint") || has("@biomejs/biome"))) {
    commands.lint = has("@biomejs/biome") ? "npx biome check ." : "npx eslint .";
    warnings.push(`lint es candidato (${commands.lint}); no hay script "lint" verificado.`);
  }
  if (!commands.typecheck && (hasTsconfig || has("typescript"))) {
    commands.typecheck = "npx tsc --noEmit";
    warnings.push('typecheck es candidato ("npx tsc --noEmit"); verifícalo antes de guardarlo.');
  }
  if (!commands.test && has("vitest")) {
    commands.test = "npx vitest run";
    warnings.push('test es candidato ("npx vitest run"); verifícalo antes de guardarlo.');
  } else if (!commands.test && has("jest")) {
    commands.test = "npx jest";
    warnings.push('test es candidato ("npx jest"); verifícalo antes de guardarlo.');
  }

  const evidence = ["package.json"];
  for (const file of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "tsconfig.json"]) {
    if (entries.includes(file)) evidence.push(file);
  }

  const conventions: Record<string, unknown> = {
    scripts: Object.keys(scripts).sort(),
  };
  if (pkg.workspaces) conventions.workspaces = true;

  const quality: Record<string, unknown> = {};
  if (typeof scripts["format:check"] === "string") quality.format = scriptCommand(packageManager, "format:check");
  else if (typeof scripts["fmt:check"] === "string") quality.format = scriptCommand(packageManager, "fmt:check");
  else if (has("prettier")) {
    quality.format = "npx prettier --check .";
    warnings.push('format es candidato ("npx prettier --check ."); verifícalo.');
  }
  if (typeof scripts.coverage === "string") quality.coverage = { command: scriptCommand(packageManager, "coverage") };
  else if (typeof scripts["test:coverage"] === "string") {
    quality.coverage = { command: scriptCommand(packageManager, "test:coverage") };
  }
  if (entries.some((entry) => entry.startsWith("playwright.config."))) {
    quality.e2e = { command: "npx playwright test" };
    warnings.push('e2e es candidato ("npx playwright test"); requiere Playwright instalado en el proyecto.');
  } else if (entries.some((entry) => entry.startsWith("cypress.config."))) {
    quality.e2e = { command: "npx cypress run" };
    warnings.push('e2e es candidato ("npx cypress run"); requiere Cypress instalado en el proyecto.');
  }
  const openapi = entries.find((entry) => /^(openapi|swagger)\.(ya?ml|json)$/i.test(entry));
  if (openapi) quality.api = { openapi };
  if (has("knip")) quality.static = { command: "npx knip" };
  else if (has("jscpd")) quality.static = { command: "npx jscpd ." };

  return {
    name: "node",
    commands,
    languages: ["javascript", ...(hasTsconfig || has("typescript") ? ["typescript"] : [])],
    frameworks,
    tooling,
    packageManager,
    evidence,
    warnings,
    conventions,
    quality,
  };
}

async function detectPython(root: string, entries: string[]): Promise<Ecosystem | null> {
  const pyproject = await readText(join(root, "pyproject.toml"));
  const requirements = await readText(join(root, "requirements.txt"));
  if (!pyproject && !requirements) return null;

  const text = `${pyproject ?? ""}\n${requirements ?? ""}`;
  const warnings: string[] = [];
  const tooling: string[] = [];
  for (const [needle, label] of [
    ["ruff", "Ruff"],
    ["mypy", "Mypy"],
    ["pytest", "Pytest"],
    ["black", "Black"],
    ["isort", "isort"],
    ["pyright", "Pyright"],
  ] as const) {
    if (text.toLowerCase().includes(needle)) tooling.push(label);
  }

  const frameworks: string[] = [];
  for (const [needle, label] of [
    ["fastapi", "FastAPI"],
    ["django", "Django"],
    ["flask", "Flask"],
    ["sqlalchemy", "SQLAlchemy"],
    ["pydantic", "Pydantic"],
  ] as const) {
    if (text.toLowerCase().includes(needle)) frameworks.push(label);
  }

  const commands: Record<string, string> = {};
  if (entries.includes("uv.lock")) commands.install = "uv sync";
  else if (entries.includes("poetry.lock")) commands.install = "poetry install";
  else if (requirements) commands.install = "python -m pip install -r requirements.txt";
  else if (pyproject) commands.install = "python -m pip install -e .";

  if (tooling.includes("Ruff")) commands.lint = "ruff check .";
  if (tooling.includes("Mypy")) commands.typecheck = "mypy .";
  if (tooling.includes("Pyright")) commands.typecheck = "pyright";
  if (tooling.includes("Pytest") || entries.includes("tests")) commands.test = "pytest";
  if (pyproject?.includes("[build-system]")) commands.build = "python -m build";

  if (!commands.test) warnings.push("No se detectó pytest; el comando de test queda pendiente.");
  if (!commands.lint) warnings.push("No se detectó linter de Python; el comando de lint queda pendiente.");

  const quality: Record<string, unknown> = {};
  if (tooling.includes("Ruff")) quality.format = "ruff format --check .";
  else if (tooling.includes("Black")) quality.format = "black --check .";
  if (text.toLowerCase().includes("pytest-cov")) {
    quality.coverage = { command: "pytest --cov --cov-report=json:coverage.json" };
  }
  const openapi = entries.find((entry) => /^(openapi|swagger)\.(ya?ml|json)$/i.test(entry));
  if (openapi) quality.api = { openapi };

  return {
    name: "python",
    commands,
    languages: ["python"],
    frameworks,
    tooling,
    packageManager: entries.includes("uv.lock") ? "uv" : entries.includes("poetry.lock") ? "poetry" : "pip",
    evidence: [
      ...(pyproject ? ["pyproject.toml"] : []),
      ...(requirements ? ["requirements.txt"] : []),
      ...(entries.includes("uv.lock") ? ["uv.lock"] : []),
      ...(entries.includes("poetry.lock") ? ["poetry.lock"] : []),
    ],
    warnings,
    quality,
  };
}

async function detectRust(root: string, entries: string[]): Promise<Ecosystem | null> {
  const raw = await readText(join(root, "Cargo.toml"));
  if (!raw) return null;
  const tooling = ["Cargo"];
  const frameworks: string[] = [];
  for (const [needle, label] of [
    ["axum", "Axum"],
    ["actix-web", "Actix Web"],
    ["rocket", "Rocket"],
    ["tokio", "Tokio"],
    ["serde", "Serde"],
    ["sqlx", "SQLx"],
    ["diesel", "Diesel"],
  ] as const) {
    if (raw.includes(needle)) frameworks.push(label);
  }
  const warnings: string[] = [];
  if (!hasCommand("cargo")) warnings.push("cargo no está instalado; los comandos Rust fallarán.");
  const quality: Record<string, unknown> = { format: "cargo fmt --check" };
  if (hasCommand("cargo-llvm-cov")) {
    quality.coverage = { command: "cargo llvm-cov --lcov --output-path lcov.info" };
  }
  const openapi = entries.find((entry) => /^(openapi|swagger)\.(ya?ml|json)$/i.test(entry));
  if (openapi) quality.api = { openapi };

  return {
    name: "rust",
    commands: {
      install: "cargo fetch",
      lint: "cargo clippy -- -D warnings",
      typecheck: "cargo check",
      test: "cargo test",
      build: "cargo build --release",
      run: "cargo run",
    },
    languages: ["rust"],
    frameworks,
    tooling,
    packageManager: "cargo",
    evidence: ["Cargo.toml", ...(entries.includes("Cargo.lock") ? ["Cargo.lock"] : [])],
    warnings,
    quality,
  };
}

async function detectGo(root: string, entries: string[]): Promise<Ecosystem | null> {
  const raw = await readText(join(root, "go.mod"));
  if (!raw) return null;
  const frameworks: string[] = [];
  for (const [needle, label] of [
    ["gin-gonic/gin", "Gin"],
    ["labstack/echo", "Echo"],
    ["gofiber/fiber", "Fiber"],
    ["go-chi/chi", "Chi"],
    ["gorm.io/gorm", "GORM"],
  ] as const) {
    if (raw.includes(needle)) frameworks.push(label);
  }
  const warnings: string[] = [];
  if (!hasCommand("go")) warnings.push("go no está instalado; los comandos Go fallarán.");
  const quality: Record<string, unknown> = {
    format: "gofmt -l .",
    coverage: { command: "go test ./... -coverprofile=coverage.out" },
  };
  const openapi = entries.find((entry) => /^(openapi|swagger)\.(ya?ml|json)$/i.test(entry));
  if (openapi) quality.api = { openapi };

  return {
    name: "go",
    commands: {
      install: "go mod download",
      lint: "golangci-lint run",
      typecheck: "go vet ./...",
      test: "go test ./...",
      build: "go build ./...",
      run: "go run .",
    },
    languages: ["go"],
    frameworks,
    tooling: ["Go"],
    packageManager: "go",
    evidence: ["go.mod", ...(entries.includes("go.sum") ? ["go.sum"] : [])],
    warnings,
    quality,
  };
}

async function detectPhp(root: string, entries: string[]): Promise<Ecosystem | null> {
  const composerRaw = await readText(join(root, "composer.json"));
  const hasPhpFiles =
    entries.some((entry) => entry.endsWith(".php")) ||
    existsSync(join(root, "public", "index.php")) ||
    existsSync(join(root, "index.php"));
  if (!composerRaw && !hasPhpFiles) return null;

  const warnings: string[] = [];
  let composer: Record<string, unknown> = {};
  if (composerRaw) {
    try {
      const parsed = JSON.parse(composerRaw) as unknown;
      if (isPlainObject(parsed)) composer = parsed;
    } catch {
      warnings.push("composer.json no es JSON válido.");
    }
  }

  const require: Record<string, unknown> = {
    ...(isPlainObject(composer.require) ? composer.require : {}),
    ...(isPlainObject(composer["require-dev"]) ? composer["require-dev"] : {}),
  };
  const has = (name: string) => Object.prototype.hasOwnProperty.call(require, name);
  const scripts = isPlainObject(composer.scripts) ? composer.scripts : {};
  const phpText = await readSome(root, ".php");
  const usesMysql = /\b(PDO|mysqli|mysql_)\b/i.test(phpText) && /\b(mysql|mariadb)\b/i.test(phpText + composerRaw);

  const frameworks: string[] = [];
  for (const [dependency, label] of [
    ["laravel/framework", "Laravel"],
    ["symfony/framework-bundle", "Symfony"],
    ["cakephp/cakephp", "CakePHP"],
    ["slim/slim", "Slim"],
    ["codeigniter4/framework", "CodeIgniter"],
  ] as const) {
    if (has(dependency)) frameworks.push(label);
  }

  const tooling: string[] = [];
  for (const [dependency, label] of [
    ["phpunit/phpunit", "PHPUnit"],
    ["pestphp/pest", "Pest"],
    ["phpstan/phpstan", "PHPStan"],
    ["vimeo/psalm", "Psalm"],
    ["squizlabs/php_codesniffer", "PHP_CodeSniffer"],
    ["friendsofphp/php-cs-fixer", "PHP-CS-Fixer"],
    ["laravel/pint", "Pint"],
  ] as const) {
    if (has(dependency)) tooling.push(label);
  }

  const commands: Record<string, string> = {};
  if (composerRaw) commands.install = entries.includes("composer.lock") ? "composer install --prefer-dist" : "composer install";
  if (typeof scripts.test === "string") commands.test = "composer test";
  else if (tooling.includes("Pest")) commands.test = "vendor/bin/pest";
  else if (entries.includes("phpunit.xml") || entries.includes("phpunit.xml.dist") || tooling.includes("PHPUnit")) {
    commands.test = "vendor/bin/phpunit";
  }
  if (typeof scripts.lint === "string") commands.lint = "composer lint";
  else if (tooling.includes("Pint")) commands.lint = "vendor/bin/pint --test";
  else if (tooling.includes("PHP-CS-Fixer")) commands.lint = "vendor/bin/php-cs-fixer fix --dry-run --diff";
  else if (tooling.includes("PHP_CodeSniffer")) commands.lint = "vendor/bin/phpcs";
  if (typeof scripts.analyse === "string") commands.typecheck = "composer analyse";
  else if (typeof scripts.analyze === "string") commands.typecheck = "composer analyze";
  else if (tooling.includes("PHPStan")) commands.typecheck = "vendor/bin/phpstan analyse --no-progress";
  else if (tooling.includes("Psalm")) commands.typecheck = "vendor/bin/psalm --no-progress";
  if (entries.includes("artisan")) commands.run = "php artisan serve";
  else if (existsSync(join(root, "public", "index.php"))) commands.run = "php -S 127.0.0.1:8000 -t public";
  else if (existsSync(join(root, "index.php"))) commands.run = "php -S 127.0.0.1:8000";

  if (composerRaw && !hasCommand("composer")) {
    warnings.push("composer no está instalado; los comandos de Composer fallarán hasta que lo instales.");
  }
  if (hasPhpFiles && !hasCommand("php")) {
    warnings.push("php no está instalado; `php -l` y el servidor de desarrollo no funcionarán.");
  }
  if (!commands.test) warnings.push("No hay test PHP detectable; la compuerta de tests se marcará skipped.");
  if (!commands.lint) warnings.push("No hay linter PHP configurado; se usará `php -l` sobre archivos cambiados si php existe.");

  const quality: Record<string, unknown> = { phpSyntax: true };
  if (tooling.includes("PHPUnit") || tooling.includes("Pest")) {
    quality.coverage = {
      command: tooling.includes("Pest") ? "vendor/bin/pest --coverage-clover coverage.xml" : "vendor/bin/phpunit --coverage-clover coverage.xml",
      note: "Requiere xdebug o pcov instalado en PHP.",
    };
  }
  const openapi = entries.find((entry) => /^(openapi|swagger)\.(ya?ml|json)$/i.test(entry));
  if (openapi) quality.api = { openapi };

  return {
    name: "php",
    commands,
    languages: ["php"],
    frameworks,
    tooling,
    packageManager: composerRaw ? "composer" : undefined,
    evidence: [
      ...(composerRaw ? ["composer.json"] : []),
      ...(entries.includes("composer.lock") ? ["composer.lock"] : []),
      ...(entries.includes("phpunit.xml") ? ["phpunit.xml"] : []),
      ...(entries.includes("phpunit.xml.dist") ? ["phpunit.xml.dist"] : []),
      ...(entries.includes("index.php") ? ["index.php"] : []),
      ...(existsSync(join(root, "public", "index.php")) ? ["public/index.php"] : []),
    ],
    warnings,
    conventions: { composerScripts: Object.keys(scripts).sort(), database: usesMysql ? "MySQL/MariaDB" : undefined },
    quality,
  };
}

async function detectJava(root: string, entries: string[]): Promise<Ecosystem | null> {
  const pom = await readText(join(root, "pom.xml"));
  const gradleFile = entries.find((entry) => entry === "build.gradle" || entry === "build.gradle.kts");
  if (!pom && !gradleFile) return null;

  const warnings: string[] = [];
  const frameworks: string[] = [];
  const tooling: string[] = [];
  const commands: Record<string, string> = {};
  const quality: Record<string, unknown> = {};
  const buildText = `${pom ?? ""}\n${gradleFile ? (await readText(join(root, gradleFile))) ?? "" : ""}`;

  if (/spring-boot|springframework\.boot/i.test(buildText)) frameworks.push("Spring Boot");
  if (buildText.includes("quarkus")) frameworks.push("Quarkus");
  if (buildText.includes("micronaut")) frameworks.push("Micronaut");
  if (buildText.includes("com.android.application")) frameworks.push("Android");

  if (pom) {
    const mvn = entries.includes("mvnw") ? "./mvnw" : "mvn";
    tooling.push("Maven");
    commands.install = `${mvn} -q -DskipTests install`;
    commands.build = `${mvn} -q -DskipTests package`;
    commands.test = `${mvn} -q test`;
    commands.typecheck = `${mvn} -q -DskipTests compile`;
    if (/checkstyle/i.test(pom)) commands.lint = `${mvn} -q checkstyle:check`;
    else if (/spotless/i.test(pom)) commands.lint = `${mvn} -q spotless:check`;
    else if (/pmd/i.test(pom)) commands.lint = `${mvn} -q pmd:check`;
    if (/spotless/i.test(pom)) quality.format = `${mvn} -q spotless:check`;
    if (/spring-boot-maven-plugin/i.test(pom)) commands.run = `${mvn} spring-boot:run`;
    if (!entries.includes("mvnw") && !hasCommand("mvn")) {
      warnings.push("mvn no está instalado y no hay mvnw; los comandos Maven fallarán hasta que lo instales.");
    }
  } else if (gradleFile) {
    const gradle = entries.includes("gradlew") ? "./gradlew" : "gradle";
    tooling.push("Gradle");
    commands.install = `${gradle} dependencies`;
    commands.build = `${gradle} build -x test`;
    commands.test = `${gradle} test`;
    commands.typecheck =
      entries.some((entry) => entry.endsWith(".kt")) || existsSync(join(root, "src", "main", "kotlin"))
        ? `${gradle} compileKotlin`
        : `${gradle} compileJava`;
    if (/spotless/i.test(buildText)) commands.lint = `${gradle} spotlessCheck`;
    else if (/checkstyle/i.test(buildText)) commands.lint = `${gradle} checkstyleMain`;
    else if (/pmd/i.test(buildText)) commands.lint = `${gradle} pmdMain`;
    if (/spotless/i.test(buildText)) quality.format = `${gradle} spotlessCheck`;
    if (/org\.springframework\.boot/i.test(buildText)) commands.run = `${gradle} bootRun`;
    else if (/application/i.test(buildText)) commands.run = `${gradle} run`;
    if (!entries.includes("gradlew") && !hasCommand("gradle")) {
      warnings.push("gradle no está instalado y no hay gradlew; los comandos Gradle fallarán hasta que lo instales.");
    }
  }

  if (!commands.lint) warnings.push("No hay linter Java configurado (checkstyle/spotless/PMD); la compuerta de lint se marcará skipped.");
  if (/jacoco/i.test(buildText)) {
    quality.coverage = { command: pom ? `${entries.includes("mvnw") ? "./mvnw" : "mvn"} -q test jacoco:report` : `${entries.includes("gradlew") ? "./gradlew" : "gradle"} jacocoTestReport` };
  }
  const openapi = entries.find((entry) => /^(openapi|swagger)\.(ya?ml|json)$/i.test(entry));
  if (openapi) quality.api = { openapi };

  return {
    name: pom ? "java-maven" : "java-gradle",
    commands,
    languages: ["java", ...(entries.some((entry) => entry.endsWith(".kt")) ? ["kotlin"] : [])],
    frameworks: unique(frameworks),
    tooling,
    packageManager: pom ? "maven" : "gradle",
    evidence: [
      ...(pom ? ["pom.xml"] : []),
      ...(gradleFile ? [gradleFile] : []),
      ...(entries.includes("mvnw") ? ["mvnw"] : []),
      ...(entries.includes("gradlew") ? ["gradlew"] : []),
    ],
    warnings,
    quality,
  };
}

async function detectRuby(root: string, entries: string[]): Promise<Ecosystem | null> {
  const gemfile = await readText(join(root, "Gemfile"));
  const hasRails = existsSync(join(root, "bin", "rails")) || existsSync(join(root, "config", "application.rb"));
  const hasRack = entries.includes("config.ru");
  if (!gemfile && !hasRails && !hasRack) return null;

  const warnings: string[] = [];
  const frameworks: string[] = [];
  const tooling: string[] = [];
  const commands: Record<string, string> = { install: "bundle install" };
  if (hasRails) {
    frameworks.push("Rails");
    commands.test = "bin/rails test";
    commands.run = "bin/rails server";
  } else if (entries.includes("spec") || entries.includes(".rspec") || gemfile?.includes("rspec")) {
    commands.test = "bundle exec rspec";
  }
  if (hasRack && !hasRails) commands.run = "bundle exec rackup";
  if (entries.includes(".rubocop.yml") || gemfile?.includes("rubocop")) {
    commands.lint = "bundle exec rubocop";
    tooling.push("RuboCop");
  }
  if (existsSync(join(root, "sorbet", "config"))) {
    commands.typecheck = "bundle exec srb tc";
    tooling.push("Sorbet");
  } else if (entries.includes("Steepfile")) {
    commands.typecheck = "bundle exec steep check";
    tooling.push("Steep");
  }
  if (gemfile?.includes("sinatra")) frameworks.push("Sinatra");
  if (!hasCommand("bundle")) {
    warnings.push("bundle no está instalado; los comandos de Bundler fallarán hasta que lo instales.");
  }
  if (!commands.test) warnings.push("No hay test Ruby detectable; la compuerta de tests se marcará skipped.");

  return {
    name: "ruby",
    commands,
    languages: ["ruby"],
    frameworks,
    tooling,
    packageManager: "bundler",
    evidence: [
      ...(gemfile ? ["Gemfile"] : []),
      ...(entries.includes("Gemfile.lock") ? ["Gemfile.lock"] : []),
      ...(entries.includes(".rspec") ? [".rspec"] : []),
      ...(hasRails ? ["bin/rails"] : []),
    ],
    warnings,
    quality: entries.find((entry) => /^(openapi|swagger)\.(ya?ml|json)$/i.test(entry))
      ? { api: { openapi: entries.find((entry) => /^(openapi|swagger)\.(ya?ml|json)$/i.test(entry)) } }
      : {},
  };
}

async function detectDotnet(root: string, entries: string[]): Promise<Ecosystem | null> {
  const project = entries.find((entry) => entry.endsWith(".csproj") || entry.endsWith(".fsproj"));
  const solution = entries.find((entry) => entry.endsWith(".sln"));
  if (!project && !solution) return null;

  const projectText = project ? (await readText(join(root, project))) ?? "" : "";
  const frameworks: string[] = [];
  if (projectText.includes("Microsoft.AspNetCore")) frameworks.push("ASP.NET Core");
  if (projectText.includes("Microsoft.EntityFrameworkCore")) frameworks.push("Entity Framework Core");
  if (projectText.includes("Microsoft.Maui")) frameworks.push(".NET MAUI");

  const warnings: string[] = [];
  if (!hasCommand("dotnet")) warnings.push("dotnet no está disponible; los comandos .NET fallarán.");
  else warnings.push("Verifica `dotnet --list-sdks`; el binario existe pero puede no tener SDK cargado.");

  return {
    name: "dotnet",
    commands: {
      install: "dotnet restore",
      build: "dotnet build --no-restore",
      test: "dotnet test --no-build",
      typecheck: "dotnet build --no-restore",
      run: project ? `dotnet run --project ${project}` : "dotnet run",
    },
    languages: ["csharp", ...(project?.endsWith(".fsproj") ? ["fsharp"] : [])],
    frameworks,
    tooling: [".NET"],
    packageManager: "dotnet",
    evidence: [project, solution, ...(entries.includes("global.json") ? ["global.json"] : [])].filter(Boolean) as string[],
    warnings,
    quality: { format: "dotnet format --verify-no-changes" },
  };
}

async function detectMake(root: string, entries: string[]): Promise<Ecosystem | null> {
  if (!entries.includes("Makefile")) return null;
  const raw = await readText(join(root, "Makefile"));
  if (!raw) return null;
  const targets = [...raw.matchAll(/^([A-Za-z0-9_.-]+)\s*:/gm)].map((match) => match[1]);
  const commands: Record<string, string> = {};
  if (targets.includes("install")) commands.install = "make install";
  if (targets.includes("lint")) commands.lint = "make lint";
  if (targets.includes("typecheck")) commands.typecheck = "make typecheck";
  if (targets.includes("test")) commands.test = "make test";
  if (targets.includes("check")) commands.typecheck = "make check";
  if (targets.includes("build")) commands.build = "make build";
  if (targets.includes("run")) commands.run = "make run";
  return {
    name: "make",
    commands,
    languages: [],
    frameworks: [],
    tooling: ["Make"],
    evidence: ["Makefile"],
    warnings: [],
    conventions: { makeTargets: unique(targets).slice(0, 40) },
  };
}

async function collectDocs(root: string, entries: string[]): Promise<string[]> {
  const docs: string[] = [];
  for (const file of [
    "AGENTS.md",
    "README.md",
    "README",
    "CONTRIBUTING.md",
    "CONTRIBUTING",
    "opencode.json",
    "opencode.jsonc",
    ".editorconfig",
  ]) {
    if (!entries.includes(file)) continue;
    const text = await readText(join(root, file), 8 * 1024);
    if (text !== null) docs.push(file);
  }
  return docs;
}

async function resolveTarget(root: string, rawPath: unknown): Promise<string> {
  const requested = typeof rawPath === "string" && rawPath.trim() ? rawPath.trim() : ".";
  const candidate = resolve(root, requested);
  const realRoot = await realpath(root).catch(() => root);
  const realCandidate = await realpath(candidate).catch(() => candidate);
  if (!inside(realRoot, realCandidate)) {
    throw new Error("La ruta indicada queda fuera del proyecto; solo se permite inspeccionar el proyecto actual.");
  }
  return realCandidate;
}

export function createProjectTools(deps: ProjectToolsDeps): ToolDef[] {
  return [
    {
      name: "project_detect",
      description:
        "Inspecciona el repo y devuelve stack, comandos candidatos y herramientas disponibles sin ejecutarlos.",
      input: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Subdirectorio dentro del proyecto.",
          },
        },
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        let target: string;
        try {
          target = await resolveTarget(project.directory, input.path);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }

        const entries = await listDir(target);
        const ecosystems: Ecosystem[] = [];
        for (const detector of [
          detectNode,
          detectPython,
          detectPhp,
          detectJava,
          detectRuby,
          detectDotnet,
          detectRust,
          detectGo,
          detectMake,
        ]) {
          const detected = await detector(target, entries);
          if (detected) ecosystems.push(detected);
        }

        const primary = ecosystems.find((ecosystem) => Object.keys(ecosystem.commands).length > 0) ?? null;
        const alternatives = ecosystems.filter((ecosystem) => ecosystem !== primary);
        const docs = await collectDocs(target, entries);
        const tooling = unique(ecosystems.flatMap((ecosystem) => ecosystem.tooling));
        const frameworks = unique(ecosystems.flatMap((ecosystem) => ecosystem.frameworks));
        const languages = unique(ecosystems.flatMap((ecosystem) => ecosystem.languages));
        const warnings = ecosystems.flatMap((ecosystem) => ecosystem.warnings);
        const evidence = unique(ecosystems.flatMap((ecosystem) => ecosystem.evidence));

        const ci = entries.includes(".gitlab-ci.yml")
          ? "GitLab CI"
          : entries.includes("Jenkinsfile")
            ? "Jenkins"
            : entries.includes("azure-pipelines.yml")
              ? "Azure Pipelines"
              : entries.includes(".github")
                ? "GitHub Actions"
                : null;

        const monorepo =
          entries.includes("pnpm-workspace.yaml") ||
          entries.includes("turbo.json") ||
          entries.includes("nx.json") ||
          entries.includes("lerna.json");

        const result = {
          root: project.directory,
          projectId: project.projectId,
          stack: {
            languages,
            frameworks,
            packageManager: primary?.packageManager ?? null,
            tooling,
            tools: toolAvailability(),
            docker: entries.includes("Dockerfile") || entries.includes("docker-compose.yml") || entries.includes("compose.yml"),
            ci,
            monorepo,
          },
          commands: primary?.commands ?? {},
          quality: primary?.quality ?? {},
          alternatives: alternatives.map((ecosystem) => ({
            name: ecosystem.name,
            commands: ecosystem.commands,
            quality: ecosystem.quality ?? {},
          })),
          evidence: unique([...evidence, ...MANIFEST_FILES.filter((file) => entries.includes(file))]),
          conventions: {
            docs,
            ...(primary?.conventions ?? {}),
          },
          warnings: unique(warnings),
          next:
            "Verifica estos comandos ejecutándolos (run_checks acepta commands como override), corrige lo que falle y guarda stack, commands, quality y conventions con project_profile_set.",
        };

        if (Object.keys(result.commands).length === 0) {
          result.warnings.push("No se detectó un stack conocido. Inspecciona el repo manualmente antes de guardar el perfil.");
        }

        return ok(result);
      },
    },
    {
      name: "project_profile_get",
      description: "Lee el perfil exacto del proyecto actual desde PostgreSQL.",
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const profile = await deps.db.getProfile(project.projectId);
        if (!profile) {
          return ok({
            found: false,
            project,
            hint: "No hay perfil guardado. Ejecuta project_detect, verifica los comandos y usa project_profile_set.",
          });
        }
        return ok({ found: true, project, profile });
      },
    },
    {
      name: "project_profile_set",
      description: "Guarda o actualiza el perfil: stack, comandos, convenciones y notas.",
      input: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: 120 },
          stack: { type: "object", additionalProperties: true },
          commands: {
            type: "object",
            properties: {
              install: { type: "string" },
              lint: { type: "string" },
              typecheck: { type: "string" },
              test: { type: "string" },
              build: { type: "string" },
              run: { type: "string" },
            },
            additionalProperties: false,
          },
          conventions: { type: "object", additionalProperties: true },
          quality: { type: "object", additionalProperties: true },
          notes: { type: "string", maxLength: 4000 },
          verified: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(input, context) {
        const project = await deps.resolveProject(String(context.sessionID));
        const existing = await deps.db.getProfile(project.projectId);

        const stack = isPlainObject(input.stack) ? input.stack : {};
        const conventions = isPlainObject(input.conventions) ? input.conventions : {};
        const qualityInput = isPlainObject(input.quality) ? input.quality : {};
        if (Object.prototype.hasOwnProperty.call(qualityInput, "policy")) {
          return fail("La política de compuertas se cambia con quality_policy_set y confirmación explícita.");
        }
        const rawCommands = isPlainObject(input.commands) ? input.commands : {};
        const commands: Record<string, string> = {};
        for (const [key, value] of Object.entries(rawCommands)) {
          if (typeof value !== "string" || !value.trim()) {
            return fail(`El comando "${key}" debe ser una cadena no vacía.`);
          }
          commands[key] = value.trim();
        }

        const name =
          (typeof input.name === "string" && input.name.trim()) ||
          existing?.name ||
          basename(project.directory);
        const notes =
          typeof input.notes === "string"
            ? input.notes.trim().slice(0, 4_000)
            : (existing?.notes ?? null);
        const verified =
          typeof input.verified === "boolean" ? input.verified : Boolean(existing?.verifiedAt);
        const verifiedAt = verified
          ? (existing?.verifiedAt ?? new Date().toISOString())
          : null;

        if (looksLikeSecret(JSON.stringify({ stack, conventions, commands, quality: qualityInput, notes }))) {
          return fail(
            "El perfil parece contener un secreto (token, contraseña o clave). No se guardó. Usa variables de entorno.",
          );
        }

        const quality: Record<string, unknown> = { ...(existing?.quality ?? {}) };
        for (const [key, value] of Object.entries(qualityInput)) {
          if (isPlainObject(value) && isPlainObject(quality[key])) {
            quality[key] = { ...quality[key], ...value };
          } else {
            quality[key] = value;
          }
        }

        const profile = await deps.db.upsertProfile({
          projectId: project.projectId,
          name,
          path: project.directory,
          stack: { ...(existing?.stack ?? {}), ...stack },
          commands: { ...(existing?.commands ?? {}), ...commands },
          conventions: { ...(existing?.conventions ?? {}), ...conventions },
          quality,
          notes,
          verifiedAt,
        });

        return ok({
          saved: true,
          profile,
          hint: verified
            ? "Perfil guardado como verificado."
            : "Perfil guardado sin verificar. Ejecuta los comandos y vuelve a guardarlo con verified=true.",
        });
      },
    },
  ];
}

export type { FactoryProfile };
