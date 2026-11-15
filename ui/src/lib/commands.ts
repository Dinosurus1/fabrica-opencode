/**
 * Comandos de barra de la consola. Se ejecutan en el cliente: no se envían al
 * modelo salvo que el comando lo decida (por ejemplo, `/continue`).
 */
export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  /** Atajo de teclado opcional; solo informativo. */
  shortcut?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "models",
    usage: "/models [proveedor/modelo]",
    description: "Lista o cambia el modelo de la sesión.",
  },
  {
    name: "agent",
    usage: "/agent [id]",
    description: "Lista o cambia el agente de la sesión.",
  },
  {
    name: "status",
    usage: "/status",
    description: "Lee el repo: rama, último commit, cambios y consumo de la sesión.",
  },
  {
    name: "continue",
    usage: "/continue",
    description: "Abre un traspaso estructurado a una sesión nueva.",
  },
  {
    name: "checkpoint",
    usage: "/checkpoint",
    description: "Guarda un traspaso ahora y lo abre para revisarlo.",
  },
  {
    name: "cd",
    usage: "/cd [proyecto]",
    description: "Cambia el proyecto activo (no es un shell).",
  },
  {
    name: "help",
    usage: "/help",
    description: "Muestra esta lista.",
  },
];

export interface ParsedSlash {
  name: string;
  arg: string;
}

export function parseSlash(input: string): ParsedSlash | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([a-zA-Z][a-zA-Z0-9-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  return { name: match[1].toLowerCase(), arg: (match[2] ?? "").trim() };
}

export function findCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((command) => command.name === name.toLowerCase());
}

/**
 * Sugerencias para el menú flotante. Solo se muestran mientras se escribe el
 * nombre del comando (sin espacio todavía).
 */
export function suggestCommands(input: string): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const firstLine = input.split("\n")[0] ?? "";
  if (/\s/.test(firstLine.slice(1))) return [];
  const query = firstLine.slice(1).toLowerCase();
  if (!query) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(query));
}

export function helpText(): string {
  return SLASH_COMMANDS.map((command) => `${command.usage}\n  ${command.description}`).join("\n\n");
}
