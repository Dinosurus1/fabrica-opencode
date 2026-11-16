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
  originalSize?: number;
  compressed?: boolean;
}

const COMPRESSIBLE_IMAGES = new Set(["image/jpeg", "image/png", "image/webp"]);
const COMPRESS_THRESHOLD_BYTES = 800 * 1024;

export function shouldCompressImage(file: File): boolean {
  return COMPRESSIBLE_IMAGES.has(file.type) && file.size > COMPRESS_THRESHOLD_BYTES;
}

async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo decodificar la imagen"));
    };
    image.src = url;
  });
}

/** Reduce imágenes grandes antes de adjuntarlas; si falla, conserva el original. */
export async function compressImage(file: File): Promise<File> {
  if (!shouldCompressImage(file)) return file;
  try {
    const image = await loadImage(file);
    const width = "width" in image ? image.width : 0;
    const height = "height" in image ? image.height : 0;
    if (!width || !height) return file;
    const scale = Math.min(1, 1600 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if ("close" in image && typeof image.close === "function") image.close();
    const mime = file.type === "image/png" ? "image/png" : "image/webp";
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, mime, 0.82);
    });
    if (!blob || blob.size >= file.size) return file;
    const extension = mime === "image/png" ? ".png" : ".webp";
    return new File([blob], file.name.replace(/\.(png|jpe?g|webp)$/i, extension), {
      type: mime,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  }
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

export function useFileAttachments(onChange?: (files: PendingAttachment[]) => void) {
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const filesRef = useRef<PendingAttachment[]>([]);
  const pendingCount = useRef(0);
  const pendingBytes = useRef(0);
  filesRef.current = files;

  const commit = (next: PendingAttachment[]) => {
    filesRef.current = next;
    setFiles(next);
    onChange?.(next);
  };

  const add = async (
    incoming: FileList | File[] | null | undefined,
    options: { guard?: () => boolean } = {},
  ) => {
    const list = incoming ? Array.from(incoming) : [];
    if (list.length === 0) return;
    setError(null);

    const accepted: File[] = [];
    let count = filesRef.current.length + pendingCount.current;
    let total =
      filesRef.current.reduce((sum, item) => sum + item.size, 0) + pendingBytes.current;

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
    pendingCount.current += accepted.length;
    pendingBytes.current += accepted.reduce((sum, file) => sum + file.size, 0);
    setReading(true);
    try {
      const prepared = await Promise.all(
        accepted.map(async (file) => {
          const compressed = await compressImage(file);
          return { file: compressed, originalSize: file.size };
        }),
      );
      const read = await Promise.all(
        prepared.map(async ({ file, originalSize }) => ({
          id: crypto.randomUUID(),
          name: file.name || "archivo",
          mime: file.type || "application/octet-stream",
          size: file.size,
          dataUrl: await readAsDataUrl(file),
          ...(file.size < originalSize ? { originalSize, compressed: true } : {}),
        })),
      );
      if (options.guard && !options.guard()) return;
      commit([...filesRef.current, ...read]);
    } catch {
      setError("No se pudo leer algún archivo.");
    } finally {
      pendingCount.current = Math.max(0, pendingCount.current - accepted.length);
      pendingBytes.current = Math.max(
        0,
        pendingBytes.current - accepted.reduce((sum, file) => sum + file.size, 0),
      );
      setReading(pendingCount.current > 0);
    }
  };

  const remove = (id: string) => {
    commit(filesRef.current.filter((item) => item.id !== id));
    setError(null);
  };

  const replace = (next: PendingAttachment[]) => {
    filesRef.current = next;
    setFiles(next);
    setError(null);
  };

  const clear = () => {
    commit([]);
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
              title={`${file.name} · ${formatSize(file.size)}${
                file.compressed && file.originalSize
                  ? ` (comprimido desde ${formatSize(file.originalSize)})`
                  : ""
              }`}
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
              {file.compressed ? (
                <span className="absolute bottom-0.5 left-0.5 rounded bg-carbon-950/90 px-1 text-[8px] font-medium text-success">
                  comprimido
                </span>
              ) : null}
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
