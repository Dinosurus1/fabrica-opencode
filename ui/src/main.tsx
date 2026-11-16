import "@fontsource-variable/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, useState, Profiler, type ProfilerOnRenderCallback } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ProjectProvider } from "./components/ProjectContext";
import { jsonRequest } from "./lib/http";
import { registerServiceWorker } from "./lib/pwa";
import { Login } from "./pages/Login";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

registerServiceWorker();

type AuthState = "checking" | "authenticated" | "anonymous";

const profileEnabled =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("profile");

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration, _baseDuration, _startTime, commitTime) => {
  if (!profileEnabled) return;
  const target = window as Window & {
    __factoryProfile?: Array<{ id: string; phase: string; actualDuration: number; commitTime: number }>;
  };
  target.__factoryProfile = [
    ...(target.__factoryProfile ?? []),
    { id, phase, actualDuration, commitTime },
  ].slice(-200);
};

function AuthGate() {
  const [state, setState] = useState<AuthState>("checking");

  useEffect(() => {
    let active = true;
    jsonRequest<{ authenticated: boolean }>("/auth/session", { timeoutMs: 8_000 })
      .then((value) => {
        if (active) setState(value.authenticated ? "authenticated" : "anonymous");
      })
      .catch(() => {
        if (active) setState("anonymous");
      });

    const unauthorized = () => setState("anonymous");
    window.addEventListener("factory:unauthorized", unauthorized);
    return () => {
      active = false;
      window.removeEventListener("factory:unauthorized", unauthorized);
    };
  }, []);

  if (state === "checking") {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <div className="flex items-center gap-2 text-xs text-faint">
          <span className="size-2 animate-pulse rounded-full bg-violet" />
          Comprobando sesión…
        </div>
      </main>
    );
  }

  if (state === "anonymous") {
    return <Login onAuthenticated={() => setState("authenticated")} />;
  }

  return (
    <ProjectProvider>
      <App />
    </ProjectProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          {profileEnabled ? (
            <Profiler id="app" onRender={onRender}>
              <AuthGate />
            </Profiler>
          ) : (
            <AuthGate />
          )}
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
