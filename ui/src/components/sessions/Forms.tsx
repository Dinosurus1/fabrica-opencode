import { ListChecks, Loader2 } from "lucide-react";
import { useState } from "react";
import type { FormAnswer, FormField, FormRequest } from "../../lib/types";
import { Button } from "../ui";

export interface FormReplyState {
  formId: string;
  action: "reply" | "cancel";
}

export interface FormsPanelProps {
  forms: FormRequest[];
  pending?: FormReplyState | null;
  error?: unknown;
  onReply: (form: FormRequest, answer: FormAnswer) => void;
  onCancel: (form: FormRequest) => void;
}

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function inputType(format?: FormField["format"]): string {
  switch (format) {
    case "email":
      return "email";
    case "uri":
      return "url";
    case "date":
      return "date";
    case "date-time":
      return "datetime-local";
    default:
      return "text";
  }
}

/**
 * Formularios de OpenCode (`form.created`). La sesión queda en pausa hasta que
 * se responde o se cancela, igual que con los permisos.
 */
export function FormsPanel({ forms, pending, error, onReply, onCancel }: FormsPanelProps) {
  const [answers, setAnswers] = useState<Record<string, FormAnswer>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  if (forms.length === 0) return null;

  const busy = Boolean(pending);
  const failure = errorText(error);

  const valueFor = (form: FormRequest, field: FormField): string | number | boolean | string[] => {
    const answer = answers[form.id];
    if (answer && field.key in answer) return answer[field.key];
    if (field.default !== undefined) return field.default;
    return field.type === "boolean" ? false : field.type === "multiselect" ? [] : "";
  };

  const setValue = (
    form: FormRequest,
    field: FormField,
    value: string | number | boolean | string[],
  ) => {
    setAnswers((current) => ({
      ...current,
      [form.id]: { ...(current[form.id] ?? {}), [field.key]: value },
    }));
    setProblems((current) => {
      if (!current[form.id]) return current;
      const next = { ...current };
      delete next[form.id];
      return next;
    });
  };

  const visible = (form: FormRequest, field: FormField): boolean => {
    if (field.hidden) return false;
    if (!field.when?.length) return true;
    return field.when.every((condition) => {
      const other = form.fields.find((item) => item.key === condition.key);
      const current = other ? valueFor(form, other) : "";
      const equal = JSON.stringify(current) === JSON.stringify(condition.value);
      return condition.op === "eq" ? equal : !equal;
    });
  };

  const validate = (form: FormRequest): string | null => {
    for (const field of form.fields) {
      if (!visible(form, field)) continue;
      const value = valueFor(form, field);
      if (field.required && (value === "" || value === undefined || (Array.isArray(value) && value.length === 0))) {
        return `Falta «${field.title ?? field.key}».`;
      }
      if (field.type === "boolean" && field.required && value !== true) {
        return `Marca «${field.title ?? field.key}».`;
      }
      if (typeof value === "string") {
        if (field.minLength !== undefined && value.length > 0 && value.length < field.minLength) {
          return `«${field.title ?? field.key}» necesita al menos ${field.minLength} caracteres.`;
        }
        if (field.maxLength !== undefined && value.length > field.maxLength) {
          return `«${field.title ?? field.key}» admite como máximo ${field.maxLength} caracteres.`;
        }
        if (field.pattern && value.length > 0) {
          try {
            if (!new RegExp(field.pattern).test(value)) {
              return `«${field.title ?? field.key}» no tiene el formato esperado.`;
            }
          } catch {
            // Un patrón inválido del servidor no debe bloquear el formulario.
          }
        }
      }
      if (typeof value === "number") {
        if (field.minimum !== undefined && value < field.minimum) {
          return `«${field.title ?? field.key}» debe ser ≥ ${field.minimum}.`;
        }
        if (field.maximum !== undefined && value > field.maximum) {
          return `«${field.title ?? field.key}» debe ser ≤ ${field.maximum}.`;
        }
      }
    }
    return null;
  };

  const submit = (form: FormRequest) => {
    const problem = validate(form);
    if (problem) {
      setProblems((current) => ({ ...current, [form.id]: problem }));
      return;
    }
    const answer: FormAnswer = {};
    for (const field of form.fields) {
      if (!visible(form, field)) continue;
      const value = valueFor(form, field);
      if (value !== "" && value !== undefined) answer[field.key] = value;
    }
    onReply(form, answer);
  };

  return (
    <section
      aria-label="Formularios pendientes"
      className="border-b border-violet/30 bg-violet/[0.06] px-3 py-2.5 lg:px-4"
    >
      <div className="mx-auto w-full max-w-3xl">
        <header className="flex flex-wrap items-center gap-2 text-[11px]">
          <ListChecks size={14} className="shrink-0 text-violet-soft" />
          <span className="font-medium text-violet-soft">
            El agente necesita datos para continuar
          </span>
          <span className="text-faint">
            {forms.length} {forms.length === 1 ? "formulario" : "formularios"}
          </span>
        </header>

        <div className="mt-2 max-h-[46vh] space-y-2 overflow-y-auto pr-0.5">
          {forms.map((form) => {
            const isBusy = pending?.formId === form.id;
            const action = isBusy ? pending?.action : undefined;
            return (
              <article
                key={form.id}
                className="rounded-lg border border-violet/25 bg-carbon-950/70 px-2.5 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-ink">{form.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-[9px] text-faint" title={form.id}>
                    {form.id.slice(0, 14)}…
                  </span>
                </div>

                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {form.fields.filter((field) => visible(form, field)).map((field) => {
                    const value = valueFor(form, field);
                    const label = field.title ?? field.key;
                    return (
                      <label
                        key={field.key}
                        className={field.type === "boolean" ? "flex items-center gap-2" : "block"}
                      >
                        {field.type !== "boolean" ? (
                          <span className="mb-1 block text-[10px] text-faint">
                            {label}
                            {field.required ? <span className="text-warning"> *</span> : null}
                          </span>
                        ) : null}
                        {field.type === "boolean" ? (
                          <input
                            type="checkbox"
                            checked={Boolean(value)}
                            onChange={(event) => setValue(form, field, event.target.checked)}
                            disabled={busy}
                            className="size-4 rounded border-line bg-carbon-900 accent-violet"
                          />
                        ) : field.type === "multiselect" ? (
                          <div className="flex flex-wrap gap-1.5 rounded-md border border-line bg-carbon-900 px-2 py-1.5">
                            {(field.options ?? []).map((option) => {
                              const list = Array.isArray(value) ? value : [];
                              const checked = list.includes(option.value);
                              return (
                                <label key={option.value} className="inline-flex items-center gap-1 text-[10px] text-muted">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() =>
                                      setValue(
                                        form,
                                        field,
                                        checked
                                          ? list.filter((item) => item !== option.value)
                                          : [...list, option.value],
                                      )
                                    }
                                    disabled={busy}
                                    className="size-3.5 accent-violet"
                                  />
                                  {option.label}
                                </label>
                              );
                            })}
                          </div>
                        ) : field.options?.length ? (
                          <select
                            className="field h-8 text-[11px]"
                            value={String(value ?? "")}
                            onChange={(event) => setValue(form, field, event.target.value)}
                            disabled={busy}
                          >
                            <option value="">Selecciona…</option>
                            {field.options.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : field.type === "number" || field.type === "integer" ? (
                          <input
                            type="number"
                            min={field.minimum}
                            max={field.maximum}
                            step={field.type === "integer" ? 1 : undefined}
                            value={typeof value === "number" ? value : value === "" ? "" : Number(value)}
                            placeholder={field.placeholder}
                            onChange={(event) =>
                              setValue(
                                form,
                                field,
                                event.target.value === "" ? "" : Number(event.target.value),
                              )
                            }
                            disabled={busy}
                            className="field h-8 text-[11px]"
                          />
                        ) : field.custom ? (
                          <textarea
                            value={String(value ?? "")}
                            placeholder={field.placeholder}
                            onChange={(event) => setValue(form, field, event.target.value)}
                            disabled={busy}
                            className="field min-h-16 resize-y text-[11px]"
                          />
                        ) : (
                          <input
                            type={inputType(field.format)}
                            value={String(value ?? "")}
                            placeholder={field.placeholder}
                            minLength={field.minLength}
                            maxLength={field.maxLength}
                            onChange={(event) => setValue(form, field, event.target.value)}
                            disabled={busy}
                            className="field h-8 text-[11px]"
                          />
                        )}
                        {field.type === "boolean" ? (
                          <span className="text-[10px] text-faint">
                            {label}
                            {field.required ? <span className="text-warning"> *</span> : null}
                          </span>
                        ) : null}
                        {field.description ? (
                          <span className="mt-0.5 block text-[9px] leading-4 text-faint">
                            {field.description}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>

                {problems[form.id] ? (
                  <p className="mt-1.5 text-[10px] text-warning">{problems[form.id]}</p>
                ) : null}

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="primary"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => submit(form)}
                    disabled={busy}
                  >
                    {action === "reply" ? <Loader2 size={12} className="animate-spin" /> : null}
                    Enviar
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => onCancel(form)}
                    disabled={busy}
                  >
                    {action === "cancel" ? <Loader2 size={12} className="animate-spin" /> : null}
                    Cancelar formulario
                  </Button>
                </div>
              </article>
            );
          })}
        </div>

        {failure ? <p className="mt-2 text-[11px] text-danger">{failure}</p> : null}
      </div>
    </section>
  );
}
