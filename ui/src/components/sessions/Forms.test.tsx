import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FormRequest } from "../../lib/types";
import { FormsPanel } from "./Forms";

const form: FormRequest = {
  id: "frm_1",
  sessionID: "ses_1",
  title: "Datos del despliegue",
  fields: [
    { key: "name", title: "Nombre", type: "string", required: true, minLength: 3 },
    { key: "env", title: "Entorno", type: "string", options: [
      { value: "dev", label: "Desarrollo" },
      { value: "prod", label: "Producción" },
    ] },
    { key: "notify", title: "Avisar", type: "boolean", default: true },
    { key: "tags", title: "Etiquetas", type: "multiselect", options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ] },
    { key: "extra", title: "Solo producción", type: "string", when: [{ key: "env", op: "eq", value: "prod" }] },
  ],
};

describe("FormsPanel", () => {
  it("muestra los campos y envía el answer", async () => {
    const onReply = vi.fn();
    render(<FormsPanel forms={[form]} onReply={onReply} onCancel={() => {}} />);
    expect(screen.getByRole("region", { name: "Formularios pendientes" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Nombre/), "Fábrica");
    await userEvent.selectOptions(screen.getByLabelText(/Entorno/), "dev");
    await userEvent.click(screen.getByLabelText(/^B$/) );
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(onReply).toHaveBeenCalledWith(
      form,
      expect.objectContaining({ name: "Fábrica", env: "dev", notify: true, tags: ["b"] }),
    );
  });

  it("valida campos obligatorios y longitudes", async () => {
    render(<FormsPanel forms={[form]} onReply={() => {}} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(screen.getByText(/Falta «Nombre»/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Nombre/), "ab");
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(screen.getByText(/al menos 3 caracteres/)).toBeInTheDocument();
  });

  it("oculta campos condicionales y permite cancelar", async () => {
    const onCancel = vi.fn();
    render(<FormsPanel forms={[form]} onReply={() => {}} onCancel={onCancel} />);
    expect(screen.queryByLabelText(/Solo producción/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar formulario" }));
    expect(onCancel).toHaveBeenCalledWith(form);
  });

  it("bloquea mientras hay una respuesta en curso y muestra errores", () => {
    render(
      <FormsPanel
        forms={[form]}
        pending={{ formId: form.id, action: "reply" }}
        error={new Error("409 Conflict")}
        onReply={() => {}}
        onCancel={() => {}}
      />,
    );
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    expect(screen.getByText("409 Conflict")).toBeInTheDocument();
  });
});
