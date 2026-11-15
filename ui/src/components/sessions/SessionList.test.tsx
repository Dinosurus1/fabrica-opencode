import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../lib/types";
import { SessionList } from "./SessionList";

const session: Session = {
  id: "ses_1",
  projectID: "p1",
  agent: "factory",
  model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
  cost: 0.01,
  tokens: { input: 100, output: 20, reasoning: 0 },
  time: { created: Date.now(), updated: Date.now() },
  title: "Prueba de lista",
  outcome: "succeeded",
};

function renderList(overrides: Partial<ComponentProps<typeof SessionList>> = {}) {
  return render(
    <SessionList
      sessions={[session]}
      runningIds={new Set()}
      selectedId={null}
      loading={false}
      liveLabel="En vivo"
      liveTone="live"
      query=""
      onQueryChange={() => {}}
      onlyProject={false}
      onOnlyProjectChange={() => {}}
      showSubagents={false}
      onShowSubagentsChange={() => {}}
      onSelect={() => {}}
      onDelete={() => {}}
      onNewChat={() => {}}
      {...overrides}
    />,
  );
}

describe("SessionList", () => {
  it("muestra la sesión y permite seleccionarla", async () => {
    const onSelect = vi.fn();
    renderList({ onSelect });
    const item = screen.getByText("Prueba de lista");
    expect(item).toBeInTheDocument();
    await userEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith("ses_1");
  });

  it("muestra el estado de trabajo por sesión", () => {
    renderList({ runningIds: new Set(["ses_1"]) });
    expect(screen.getByText(/Trabajando/)).toBeInTheDocument();
  });

  it("usa un estado vacío claro", () => {
    renderList({ sessions: [] });
    expect(screen.getByText(/Sin conversaciones/)).toBeInTheDocument();
  });
});
