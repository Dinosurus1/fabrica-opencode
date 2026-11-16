import {
  ArrowDown,
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  CircleX,
  Copy,
  FileCode2,
  Globe,
  ListChecks,
  Loader2,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, memo, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, formatCompact, formatDate, formatUsd, modelLabel } from "../../lib/format";
import type { MessagePart, SessionMessage } from "../../lib/types";
import { MessageFiles } from "./attachments";

const TEST_ENVIRONMENT =
  typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);

export function messageText(message: SessionMessage): string {
  const parts = (message.content ?? [])
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text!.trim())
    .filter(Boolean);
  return (parts.join("\n") || message.text || "").trim();
}

export type Turn =
  | { kind: "user"; messages: SessionMessage[] }
  | { kind: "assistant"; messages: SessionMessage[] }
  | { kind: "info"; messages: SessionMessage[] };

export function buildTurns(messages: SessionMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.type === "assistant") {
      const last = turns.at(-1);
      if (last?.kind === "assistant") last.messages.push(message);
      else turns.push({ kind: "assistant", messages: [message] });
      continue;
    }
    if (message.type === "user") {
      turns.push({ kind: "user", messages: [message] });
      continue;
    }
    if (message.type === "idle") continue;
    if (message.type === "system") {
      turns.push({ kind: "info", messages: [message] });
      continue;
    }
    turns.push({ kind: "info", messages: [message] });
  }
  return turns;
}

function assistantTokens(messages: SessionMessage[]): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const message of messages) {
    if (message.tokens) {
      tokens +=
        (message.tokens.input ?? 0) +
        (message.tokens.output ?? 0) +
        (message.tokens.reasoning ?? 0) +
        (message.tokens.cache?.read ?? 0) +
        (message.tokens.cache?.write ?? 0);
    }
    if (typeof message.cost === "number") cost += message.cost;
  }
  return { tokens, cost };
}

function lastAssistantMeta(messages: SessionMessage[]): SessionMessage | undefined {
  return [...messages].reverse().find((message) => message.agent || message.model);
}

export function Transcript({
  messages,
  running,
  loading,
  error,
  onRetry,
  sessionId,
}: {
  messages: SessionMessage[];
  running: boolean;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  sessionId?: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const restored = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [stick, setStick] = useState(true);
  const [windowSize, setWindowSize] = useState(80);
  const visibleMessages = useMemo(
    () => (messages.length > windowSize ? messages.slice(-windowSize) : messages),
    [messages, windowSize],
  );
  const turns = useMemo(() => buildTurns(visibleMessages), [visibleMessages]);
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 140,
    overscan: 8,
    getItemKey: (index) => turns[index]?.messages[0]?.id ?? index,
  });
  const virtualize = !TEST_ENVIRONMENT;
  const storageKey = sessionId ? `factory.sessions.scroll.${sessionId}` : null;
  const lastTextLength = visibleMessages.length
    ? messageText(visibleMessages[visibleMessages.length - 1]).length
    : 0;

  useEffect(() => {
    restored.current = false;
    setStick(true);
    setWindowSize(80);
  }, [sessionId]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (!restored.current && messages.length > 0) {
      restored.current = true;
      const saved = Number((storageKey && localStorage.getItem(storageKey)) || 0);
      const distanceToBottom = node.scrollHeight - node.clientHeight - saved;
      if (saved > 0 && distanceToBottom > 120) {
        node.scrollTop = saved;
        setStick(false);
        return;
      }
    }
    if (!stick) return;
    const frame = requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (current) current.scrollTop = current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, turns.length, running, lastTextLength, stick, storageKey]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    setStick(distance < 120);
    if (storageKey) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        try {
          localStorage.setItem(storageKey, String(Math.round(node.scrollTop)));
        } catch {
          // localStorage lleno o no disponible; el scroll sigue en memoria.
        }
      }, 150);
    }
  };

  const jumpToEnd = () => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    setStick(true);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto px-4 py-5 lg:px-8"
        aria-live="polite"
      >
        <div className="mx-auto w-full max-w-3xl">
          {loading && messages.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted">
              <Loader2 size={14} className="animate-spin" /> Cargando conversación…
            </div>
          ) : error ? (
            <div className="mx-auto max-w-md rounded-xl border border-danger/30 bg-danger/5 px-4 py-4 text-center">
              <p className="text-xs font-medium text-danger">No se pudo cargar la conversación</p>
              <p className="mt-1 break-words text-[11px] text-muted">
                {error instanceof Error ? error.message : String(error)}
              </p>
              {onRetry ? (
                <button
                  className="mt-3 text-[11px] font-medium text-violet-soft hover:text-violet"
                  onClick={onRetry}
                >
                  Reintentar
                </button>
              ) : null}
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-3 grid size-10 place-items-center rounded-xl border border-line bg-carbon-900 text-faint">
                <Sparkles size={18} />
              </div>
              <p className="text-sm font-medium text-ink">Conversación vacía</p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-muted">
                Escribe el primer mensaje para que el agente empiece a trabajar en este proyecto.
              </p>
            </div>
          ) : (
            <>
              {messages.length > visibleMessages.length ? (
                <div className="mb-4 flex justify-center">
                  <button
                    type="button"
                    className="rounded-md border border-line bg-carbon-900 px-3 py-1 text-[11px] text-muted transition-colors hover:text-ink"
                    onClick={() => setWindowSize((size) => size + 60)}
                  >
                    Cargar 60 mensajes anteriores
                  </button>
                </div>
              ) : null}
              {virtualize ? (
                <div
                  style={{
                    height: `${virtualizer.getTotalSize()}px`,
                    position: "relative",
                    width: "100%",
                  }}
                >
                  {virtualizer.getVirtualItems().map((item) => (
                    <div
                      key={item.key}
                      data-index={item.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${item.start}px)`,
                        paddingBottom: 24,
                      }}
                    >
                      <TurnView
                        turn={turns[item.index]}
                        live={running && item.index === turns.length - 1}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-6">
                  {turns.map((turn, index) => (
                    <TurnView
                      key={turn.messages[0]?.id ?? index}
                      turn={turn}
                      live={running && index === turns.length - 1}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {running && messages.length > 0 ? (
            <div className="mt-4 flex items-center gap-2 pl-1 text-[11px] text-muted">
              <span className="flex gap-1">
                <span className="size-1.5 animate-bounce rounded-full bg-violet-soft [animation-delay:0ms]" />
                <span className="size-1.5 animate-bounce rounded-full bg-violet-soft [animation-delay:120ms]" />
                <span className="size-1.5 animate-bounce rounded-full bg-violet-soft [animation-delay:240ms]" />
              </span>
              Trabajando…
            </div>
          ) : null}
          <div className="h-2" />
        </div>
      </div>

      {!stick && messages.length > 0 ? (
        <button
          onClick={jumpToEnd}
          className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-carbon-800/95 px-3 py-1.5 text-[11px] font-medium text-muted shadow-lg shadow-black/40 backdrop-blur transition-colors hover:text-ink"
        >
          <ArrowDown size={12} /> Ir al final
        </button>
      ) : null}
    </div>
  );
}

function TurnView({ turn, live }: { turn: Turn; live: boolean }) {
  if (turn.kind === "user") {
    const message = turn.messages[0];
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2 pr-1 text-[10px] text-faint">
          <span>{formatDate(message.time?.created)}</span>
          <span className="font-medium uppercase tracking-[0.08em]">Tú</span>
        </div>
        <div className="max-w-[88%] rounded-2xl rounded-br-md border border-line bg-carbon-800 px-4 py-3 shadow-sm shadow-black/20">
          {message.files?.length ? <MessageFiles files={message.files} /> : null}
          {messageText(message) ? <RichText text={messageText(message)} /> : null}
        </div>
      </div>
    );
  }

  if (turn.kind === "info") {
    const message = turn.messages[0];
    const label =
      message.type === "system"
        ? message.text
        : message.type === "compaction"
          ? "Contexto compactado"
          : message.type === "synthetic"
            ? "Mensaje sintético"
            : message.type === "shell"
              ? "Comando de shell"
              : message.text;
    return (
      <div className="flex items-center justify-center gap-2 text-[10px] text-faint">
        <span className="h-px w-8 bg-line" />
        <span className="max-w-lg truncate">{label ?? message.type}</span>
        <span className="h-px w-8 bg-line" />
      </div>
    );
  }

  const messages = turn.messages;
  const meta = lastAssistantMeta(messages);
  const { tokens, cost } = assistantTokens(messages);
  const hasBody = messages.some(
    (message) => (message.content ?? []).length > 0 || messageText(message),
  );

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-violet/30 bg-violet/10 text-violet-soft">
        <Bot size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-faint">
          <span className="font-medium uppercase tracking-[0.08em] text-muted">
            {meta?.agent ?? "assistant"}
          </span>
          {meta?.model ? (
            <span className="font-mono">{modelLabel(meta.model.providerID, meta.model.id)}</span>
          ) : null}
          <span className="ml-auto">{formatDate(meta?.time?.created)}</span>
        </div>

        {hasBody ? (
          <AssistantBody messages={messages} />
        ) : (
          <p className="text-xs text-faint">Sin contenido de texto.</p>
        )}

        {live ? (
          <span className="mt-2 inline-block h-3.5 w-[2px] animate-pulse rounded-full bg-violet-soft align-middle" />
        ) : null}

        {messages.some((message) => message.error) ? (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger">
            <CircleAlert size={13} className="mt-0.5 shrink-0" />
            <span className="break-words">
              {String(
                (messages.find((message) => message.error)?.error as { message?: string })?.message ??
                  "La ejecución terminó con error.",
              )}
            </span>
          </div>
        ) : null}

        {tokens > 0 && !live ? (
          <div className="mt-2 flex items-center gap-2 text-[10px] text-faint">
            <span>{formatCompact(tokens)} tokens</span>
            {cost > 0 ? <span>· {formatUsd(cost)}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssistantBody({ messages }: { messages: SessionMessage[] }) {
  const parts = useMemo(() => {
    const output: Array<{ part: MessagePart; message: SessionMessage }> = [];
    for (const message of messages) {
      if ((message.content ?? []).length === 0 && messageText(message)) {
        output.push({ part: { type: "text", text: messageText(message) }, message });
        continue;
      }
      for (const part of message.content ?? []) output.push({ part, message });
    }
    return output;
  }, [messages]);

  const nodes: ReactNode[] = [];
  let toolBuffer: MessagePart[] = [];

  const flushTools = (key: string) => {
    if (toolBuffer.length === 0) return;
    const tools = toolBuffer;
    toolBuffer = [];
    nodes.push(<ToolCluster key={key} tools={tools} />);
  };

  parts.forEach((item, index) => {
    const { part } = item;
    if (part.type === "tool") {
      toolBuffer.push(part);
      return;
    }
    flushTools(`tools-${index}`);

    if (part.type === "text" && part.text?.trim()) {
      nodes.push(<RichText key={`text-${index}`} text={part.text} />);
      return;
    }
    if (part.type === "reasoning" && part.text?.trim()) {
      nodes.push(<Reasoning key={`reasoning-${index}`} text={part.text} />);
      return;
    }
    if (part.type === "compaction") {
      nodes.push(
        <div key={`compaction-${index}`} className="text-[11px] text-faint">
          Contexto compactado
        </div>,
      );
    }
  });
  flushTools("tools-end");

  return <div className="space-y-3">{nodes}</div>;
}

function Reasoning({ text }: { text: string }) {
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 80);
  return (
    <details className="group rounded-lg border border-line-soft bg-carbon-950/60">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px] text-muted transition-colors hover:text-ink">
        <Brain size={12} className="shrink-0 text-faint" />
        <span className="min-w-0 truncate">Razonamiento{preview ? ` · ${preview}` : ""}</span>
        <ChevronRight size={12} className="ml-auto shrink-0 text-faint transition-transform group-open:rotate-90" />
      </summary>
      <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words border-t border-line-soft px-3 py-2 text-[11px] leading-5 text-muted [overflow-wrap:anywhere]">
        {text}
      </div>
    </details>
  );
}

const TOOL_ICONS: Array<{ match: RegExp; icon: typeof Terminal }> = [
  { match: /shell|bash|exec|command/i, icon: Terminal },
  { match: /read|write|edit|patch|file/i, icon: FileCode2 },
  { match: /grep|glob|search|find/i, icon: Search },
  { match: /web|fetch|http/i, icon: Globe },
  { match: /todo|task|plan/i, icon: ListChecks },
];

function toolIcon(name: string) {
  return TOOL_ICONS.find((entry) => entry.match.test(name))?.icon ?? Wrench;
}

function toolStatus(part: MessagePart): string {
  return String(part.state?.status ?? "completed");
}

function toolDetail(part: MessagePart): string {
  const input = part.state?.input as Record<string, unknown> | undefined;
  if (!input) return "";
  for (const key of ["command", "path", "filePath", "pattern", "query", "description", "url"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function ToolChip({ part }: { part: MessagePart }) {
  const name = part.name ?? part.tool ?? "tool";
  const status = toolStatus(part);
  const detail = toolDetail(part);
  const Icon = toolIcon(name);
  const stateColor =
    status === "error"
      ? "text-danger"
      : status === "running" || status === "streaming"
        ? "text-violet-soft"
        : "text-faint";

  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-line-soft bg-carbon-950/70 px-2.5 py-1.5"
      title={detail || name}
    >
      <Icon size={12} className={cn("shrink-0", stateColor)} />
      <span className="shrink-0 font-mono text-[10px] font-medium text-ink">{name}</span>
      {detail ? (
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-faint">{detail}</span>
      ) : (
        <span className="flex-1" />
      )}
      {status === "running" || status === "streaming" ? (
        <Loader2 size={11} className="shrink-0 animate-spin text-violet-soft" />
      ) : status === "error" ? (
        <CircleX size={11} className="shrink-0 text-danger" />
      ) : (
        <Check size={11} className="shrink-0 text-success/70" />
      )}
    </div>
  );
}

function ToolCluster({ tools }: { tools: MessagePart[] }) {
  if (tools.length === 1) return <ToolChip part={tools[0]} />;
  const running = tools.some((part) => ["running", "streaming"].includes(toolStatus(part)));
  const failed = tools.some((part) => toolStatus(part) === "error");
  return (
    <details className="group rounded-lg border border-line-soft bg-carbon-950/50">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-[10px] text-muted transition-colors hover:text-ink">
        {running ? (
          <Loader2 size={12} className="animate-spin text-violet-soft" />
        ) : failed ? (
          <CircleX size={12} className="text-danger" />
        ) : (
          <ListChecks size={12} className="text-faint" />
        )}
        <span className="font-medium">{tools.length} herramientas</span>
        <span className="ml-auto flex items-center gap-1 text-faint">
          {running ? "en curso" : "completadas"}
          <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
        </span>
      </summary>
      <div className="max-h-80 space-y-1 overflow-y-auto border-t border-line-soft px-2 py-2">
        {tools.map((part, index) => (
          <ToolChip key={`${part.id ?? index}`} part={part} />
        ))}
      </div>
    </details>
  );
}

const RichText = memo(function RichText({ text }: { text: string }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <div className="space-y-2.5">
      {blocks.map((block, index) =>
        block.kind === "code" ? (
          <CodeBlock key={`code-${index}`} code={block.value} language={block.language} />
        ) : (
          <TextBlock key={`text-${index}`} value={block.value} />
        ),
      )}
    </div>
  );
});

type Block = { kind: "text"; value: string } | { kind: "code"; value: string; language: string };

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text))) {
    if (match.index > last) blocks.push({ kind: "text", value: text.slice(last, match.index) });
    blocks.push({ kind: "code", language: match[1].trim() || "text", value: match[2].replace(/\n$/, "") });
    last = fence.lastIndex;
  }
  if (last < text.length) blocks.push({ kind: "text", value: text.slice(last) });
  return blocks.filter((block) => block.kind === "code" || block.value.trim().length > 0);
}

function TextBlock({ value }: { value: string }) {
  const nodes = useMemo(() => renderTextBlock(value), [value]);
  return <div className="space-y-2">{nodes}</div>;
}

function renderTextBlock(value: string): ReactNode[] {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join("\n");
    paragraph = [];
    nodes.push(
      <p
        key={`p-${nodes.length}`}
        className="whitespace-pre-wrap break-words text-[13px] leading-6 text-ink [overflow-wrap:anywhere]"
      >
        {renderInline(text)}
      </p>,
    );
  };

  const flushList = () => {
    if (!list) return;
    const current = list;
    list = null;
    const items = current.items.map((item, index) => (
      <li key={`${index}`} className="pl-1">
        {renderInline(item)}
      </li>
    ));
    nodes.push(
      current.ordered ? (
        <ol key={`ol-${nodes.length}`} className="list-decimal space-y-1 pl-5 text-[13px] leading-6 text-ink">
          {items}
        </ol>
      ) : (
        <ul key={`ul-${nodes.length}`} className="list-disc space-y-1 pl-5 text-[13px] leading-6 text-ink">
          {items}
        </ul>
      ),
    );
  };

  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (list?.ordered) flushList();
      list ??= { ordered: false, items: [] };
      list.items.push(bullet[1]);
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      if (list && !list.ordered) flushList();
      list ??= { ordered: true, items: [] };
      list.items.push(numbered[1]);
      continue;
    }

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      nodes.push(
        <h4
          key={`h-${nodes.length}`}
          className={cn(
            "font-semibold tracking-[-0.01em] text-ink",
            level <= 2 ? "text-[15px]" : "text-[13.5px]",
            nodes.length > 0 ? "pt-1" : "",
          )}
        >
          {renderInline(heading[2])}
        </h4>,
      );
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flush();
      nodes.push(<hr key={`hr-${nodes.length}`} className="border-line-soft" />);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flush();
      nodes.push(
        <blockquote
          key={`quote-${nodes.length}`}
          className="border-l-2 border-violet/40 pl-3 text-[12.5px] leading-6 text-muted"
        >
          {renderInline(line.replace(/^\s*>\s?/, ""))}
        </blockquote>,
      );
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flush();
  return nodes;
}

function renderInline(value: string): ReactNode[] {
  const pieces = value.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g);
  return pieces.map((piece, index) => {
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
      return (
        <code
          key={index}
          className="rounded border border-line-soft bg-carbon-950 px-1 py-0.5 font-mono text-[11px] text-violet-soft"
        >
          {piece.slice(1, -1)}
        </code>
      );
    }
    if (piece.startsWith("**") && piece.endsWith("**") && piece.length > 4) {
      return (
        <strong key={index} className="font-semibold text-ink">
          {renderInline(piece.slice(2, -2))}
        </strong>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(piece);
    if (link && /^(https?:|mailto:)/i.test(link[2])) {
      return (
        <a
          key={index}
          href={link[2]}
          target="_blank"
          rel="noreferrer"
          className="text-violet-soft underline decoration-violet/40 underline-offset-2 hover:text-violet"
        >
          {link[1]}
        </a>
      );
    }
    return <span key={index}>{piece}</span>;
  });
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Sin permiso de portapapeles: se ignora.
    }
  };
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-carbon-950">
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-faint">{language}</span>
        <button
          className="ml-auto flex items-center gap-1 text-[10px] text-faint transition-colors hover:text-ink"
          onClick={() => void copy()}
        >
          {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
      <pre className="max-h-96 overflow-auto px-3 py-2.5">
        <code className="font-mono text-[11px] leading-5 text-ink">{code}</code>
      </pre>
    </div>
  );
}
