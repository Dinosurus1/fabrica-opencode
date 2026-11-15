import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui";

interface Props {
  children: ReactNode;
  /** Cambiar esta clave limpia el error (por ejemplo, al cambiar de ruta). */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Sin prompts ni secretos: solo el error y el componente que falló.
    console.error("[factory-console] error de render", error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="surface border-danger/30 px-5 py-6">
        <h2 className="text-sm font-semibold text-danger">La vista ha fallado</h2>
        <p className="mt-1 break-words text-xs leading-5 text-muted">
          {this.state.error.message || "Error inesperado de la interfaz."}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => this.setState({ error: null })}>Reintentar</Button>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            Recargar consola
          </Button>
        </div>
      </div>
    );
  }
}
