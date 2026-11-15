import { KeyRound, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { HttpError, jsonRequest } from "../lib/http";

export function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || pending) return;
    setPending(true);
    setError(null);
    try {
      await jsonRequest("/auth/login", {
        method: "POST",
        headers: { "x-factory-ui": "1" },
        body: JSON.stringify({ password }),
      });
      onAuthenticated();
    } catch (cause) {
      if (cause instanceof HttpError && cause.status === 429) {
        const retry = /retry_after/.test(cause.body) ? " Espera unos minutos." : "";
        setError(`Demasiados intentos.${retry}`);
      } else if (cause instanceof HttpError && cause.status === 401) {
        setError("Contraseña incorrecta.");
      } else {
        setError("No se pudo iniciar sesión. Comprueba que la consola esté en marcha.");
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <form
        onSubmit={submit}
        className="surface w-full max-w-sm px-6 py-7 shadow-2xl shadow-black/40"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg border border-violet/40 bg-violet/15 text-sm font-bold text-violet-soft">
            F
          </div>
          <div>
            <h1 className="text-base font-semibold text-ink">Factory Console</h1>
            <p className="text-xs text-muted">Acceso privado a la fábrica</p>
          </div>
        </div>

        <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.08em] text-faint">
          Contraseña de la consola
        </label>
        <div className="relative">
          <KeyRound size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="field h-11 pl-9"
            placeholder="••••••••••••"
            aria-label="Contraseña de la consola"
          />
        </div>

        {error ? (
          <p role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={!password || pending}
          className="btn-primary mt-5 h-11 w-full"
        >
          {pending ? <Loader2 size={15} className="animate-spin" /> : null}
          {pending ? "Entrando…" : "Entrar"}
        </button>

        <p className="mt-4 text-[10px] leading-4 text-faint">
          La sesión se guarda en una cookie HttpOnly. La contraseña se configura con
          <span className="font-mono"> FACTORY_UI_PASSWORD</span> o se reutiliza la de OpenCode.
        </p>
      </form>
    </main>
  );
}
