import { FileText, Loader2, Paperclip, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { cn } from "../../lib/format";
import type { PromptFileAttachment } from "../../lib/types";

export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export interface PendingAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  dataUrl: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems = Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  return fromItems.length > 0 ? fromItems : Array.from(data.files);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el archivo"));
    reader.readAsDataURL(file);
  });
}

export function useFileAttachments() {
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const filesRef = useRef<PendingAttachment[]>([]);
  filesRef.current = files;

  const add = async (incoming: FileList | File[] | null | undefined) => {
    const list = incoming ? Array.from(incoming) : [];
    if (list.length === 0) return;
    setError(null);

    const accepted: File[] = [];
    let count = filesRef.current.length;
    let total = filesRef.current.reduce((sum, item) => sum + item.size, 0);

    for (const file of list) {
      if (count >= MAX_ATTACHMENTS) {
        setError(`Máximo ${MAX_ATTACHMENTS} archivos por mensaje.`);
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`«${file.name}» supera ${formatSize(MAX_ATTACHMENT_BYTES)}.`);
        continue;
      }
      if (total + file.size > MAX_TOTAL_BYTES) {
        setError(`Los adjuntos superan ${formatSize(MAX_TOTAL_BYTES)} en total.`);
        break;
      }
      accepted.push(file);
      count += 1;
      total += file.size;
    }

    if (accepted.length === 0) return;
    setReading(true);
    try {
      const read = await Promise.all(
        accepted.map(async (file) => ({
          id: crypto.randomUUID(),
          name: file.name || "archivo",
          mime: file.type || "application/octet-stream",
          size: file.size,
          dataUrl: await readAsDataUrl(file),
        })),
      );
      setFiles((current) => [...current, ...read]);
    } catch {
      setError("No se pudo leer algún archivo.");
    } finally {
      setReading(false);
    }
  };

  const remove = (id: string) => {
    setFiles((current) => current.filter((item) => item.id !== id));
    setError(null);
  };

  const replace = (next: PendingAttachment[]) => {
    filesRef.current = next;
    setFiles(next);
    setError(null);
  };

  const clear = () => {
    filesRef.current = [];
    setFiles([]);
    setError(null);
  };

  return { files, add, remove, replace, clear, error, setError, reading };
}

export function AttachmentButton({
  onAdd,
  disabled,
  className,
}: {
  onAdd: (files: FileList) => void;
  disabled?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files) onAdd(event.target.files);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-carbon-900 text-muted transition-colors hover:text-ink disabled:opacity-40",
          className,
        )}
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        title="Adjuntar archivos, imágenes o documentos"
        aria-label="Adjuntar archivos"
      >
        <Paperclip size={14} />
      </button>
    </>
  );
}

export function AttachmentChips({
  files,
  onRemove,
  error,
  reading,
  compact,
}: {
  files: PendingAttachment[];
  onRemove: (id: string) => void;
  error?: string | null;
  reading?: boolean;
  compact?: boolean;
}) {
  if (files.length === 0 && !error && !reading) return null;
  return (
    <div className="mb-2">
      <div className="flex flex-wrap gap-2">
        {files.map((file) => {
          const image = file.mime.startsWith("image/");
          return (
            <div
              key={file.id}
              className={cn(
                "group relative flex items-center gap-2 overflow-hidden rounded-lg border border-line bg-carbon-900",
                image ? "p-1" : "px-2 py-1.5",
              )}
              title={`${file.name} · ${formatSize(file.size)}`}
            >
              {image ? (
                <img
                  src={file.dataUrl}
                  alt={file.name}
                  className={cn("rounded-md object-cover", compact ? "size-10" : "size-14")}
                />
              ) : (
                <>
                  <FileText size={14} className="shrink-0 text-violet-soft" />
                  <span className="max-w-[180px] truncate text-[11px] text-ink">{file.name}</span>
                  <span className="shrink-0 text-[10px] text-faint">{formatSize(file.size)}</span>
                </>
              )}
              <button
                type="button"
                onClick={() => onRemove(file.id)}
                className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-full border border-line bg-carbon-950/90 text-faint transition-colors hover:text-danger"
                aria-label={`Quitar ${file.name}`}
              >
                <X size={10} />
              </button>
            </div>
          );
        })}
        {reading ? (
          <div className="flex items-center gap-1.5 text-[10px] text-faint">
            <Loader2 size={12} className="animate-spin" /> Leyendo…
          </div>
        ) : null}
      </div>
      {error ? <p className="mt-1 text-[10px] text-danger">{error}</p> : null}
    </div>
  );
}

function fileUrl(file: PromptFileAttachment): string | undefined {
  if (file.source?.type === "uri") return file.source.uri;
  if (file.data) return `data:${file.mime ?? "application/octet-stream"};base64,${file.data}`;
  return undefined;
}

/** Adjuntos ya enviados, tal y como vienen en el mensaje del usuario. */
export function MessageFiles({ files }: { files: PromptFileAttachment[] }) {
  const items = useMemo(() => files.map((file) => ({ file, url: fileUrl(file) })), [files]);
  if (items.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {items.map(({ file, url }, index) => {
        const name = file.name ?? `adjunto-${index + 1}`;
        const image = (file.mime ?? "").startsWith("image/") && Boolean(url);
        if (image) {
          return (
            <a
              key={`${name}-${index}`}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="block overflow-hidden rounded-lg border border-line"
              title={name}
            >
              <img src={url} alt={name} className="max-h-44 max-w-[240px] object-cover" />
            </a>
          );
        }
        return (
          <a
            key={`${name}-${index}`}
            href={url}
            download={name}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-lg border border-line bg-carbon-900 px-2.5 py-1.5 transition-colors hover:border-violet/40"
            title={name}
          >
            <FileText size={14} className="shrink-0 text-violet-soft" />
            <span className="max-w-[200px] truncate text-[11px] text-ink">{name}</span>
            <span className="text-[10px] text-faint">{file.mime ?? ""}</span>
          </a>
        );
      })}
    </div>
  );
}
