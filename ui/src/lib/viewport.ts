import { useEffect } from "react";

/**
 * Mantiene `--app-height` sincronizado con `visualViewport`.
 * En iOS el teclado no cambia `100dvh`; con esta variable el compositor y el
 * panel de sesiones se encogen y no quedan tapados.
 */
export function useViewportHeight() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      const height = viewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
      document.documentElement.style.setProperty(
        "--keyboard-inset",
        `${Math.max(0, Math.round(window.innerHeight - height))}px`,
      );
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
}
