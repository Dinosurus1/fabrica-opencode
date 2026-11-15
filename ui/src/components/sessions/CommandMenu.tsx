import type { SlashCommand } from "../../lib/commands";
import { cn } from "../../lib/format";

export function CommandMenu({
  commands,
  activeIndex,
  onPick,
}: {
  commands: SlashCommand[];
  activeIndex: number;
  onPick: (command: SlashCommand) => void;
}) {
  if (commands.length === 0) return null;
  return (
    <div className="absolute bottom-full left-0 z-30 mb-2 w-full overflow-hidden rounded-xl border border-line bg-carbon-950 shadow-2xl shadow-black/50">
      <div className="border-b border-line-soft px-3 py-1.5 text-[10px] uppercase tracking-[0.08em] text-faint">
        Comandos
      </div>
      <ul className="max-h-64 overflow-y-auto py-1">
        {commands.map((command, index) => (
          <li key={command.name}>
            <button
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(command);
              }}
              className={cn(
                "flex w-full flex-wrap items-baseline gap-x-2 px-3 py-1.5 text-left text-[12px]",
                index === activeIndex
                  ? "bg-violet/15 text-ink"
                  : "text-muted transition-colors hover:bg-carbon-900",
              )}
            >
              <span className="font-mono text-violet-soft">{command.usage}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-faint">
                {command.description}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="border-t border-line-soft px-3 py-1 text-[9px] text-faint">
        ↑↓ navegar · Tab completar · Enter ejecutar · Esc cerrar
      </div>
    </div>
  );
}
