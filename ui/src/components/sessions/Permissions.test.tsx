import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PermissionRequest } from "../../lib/types";
import { PermissionsPanel } from "./Permissions";

const request: PermissionRequest = {
  id: "per_1dd771b2a0012Q2MPhNOPOnOwy",
  sessionID: "ses_1",
  action: "shell",
  resources: ["git status --short", "git log --oneline -15"],
  save: ["git status *", "git log *"],
};

describe("PermissionsPanel", () => {
  it("muestra la acción, los comandos y las reglas que se guardarían", () => {
    render(<PermissionsPanel requests={[request]} onReply={() => {}} />);
    expect(screen.getByRole("region", { name: "Permisos pendientes" })).toBeInTheDocument();
    expect(screen.getByText("Ejecutar comandos")).toBeInTheDocument();
    expect(screen.getByText("git status --short")).toBeInTheDocument();
    expect(screen.getByText(/git status \*/)).toBeInTheDocument();
  });

  it("responde una vez, siempre o rechaza con motivo", async () => {
    const onReply = vi.fn();
    render(<PermissionsPanel requests={[request]} onReply={onReply} />);

    await userEvent.click(screen.getByRole("button", { name: "Permitir una vez" }));
    expect(onReply).toHaveBeenLastCalledWith(request, "once");

    await userEvent.click(screen.getByRole("button", { name: "Permitir siempre" }));
    expect(onReply).toHaveBeenLastCalledWith(request, "always");

    await userEvent.type(screen.getByLabelText("Motivo del rechazo"), "revisa antes");
    await userEvent.click(screen.getByRole("button", { name: "Rechazar" }));
    expect(onReply).toHaveBeenLastCalledWith(request, "reject", "revisa antes");
  });

  it("bloquea los botones mientras hay una respuesta en curso", () => {
    render(
      <PermissionsPanel
        requests={[request]}
        pending={{ requestId: request.id, decision: "always" }}
        onReply={() => {}}
      />,
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("muestra el error del servidor al responder", () => {
    render(
      <PermissionsPanel requests={[request]} error={new Error("404 Not Found")} onReply={() => {}} />,
    );
    expect(screen.getByText("404 Not Found")).toBeInTheDocument();
  });

  it("no renderiza nada sin solicitudes", () => {
    const { container } = render(<PermissionsPanel requests={[]} onReply={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
