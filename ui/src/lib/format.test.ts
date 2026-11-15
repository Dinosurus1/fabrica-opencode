import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  cn,
  formatCompact,
  formatNumber,
  formatUsd,
  modelLabel,
  percent,
  shortPath,
  statusClass,
} from "./format";

describe("format", () => {
  it("une clases y descarta valores falsos", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("formatea números y compactos", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(12345)).toBe("12.345");
    expect(formatCompact(1_500_000)).toMatch(/1,5/);
  });

  it("formatea dólares con precisión variable", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.00053)).toBe("$0.0005");
    expect(formatUsd("2.5")).toBe("$2.50");
    expect(formatUsd(undefined)).toBe("—");
  });

  it("acorta rutas del home y etiqueta modelos", () => {
    expect(shortPath(`${homedir()}/.config/opencode`)).toBe("~/.config/opencode");
    expect(shortPath(null)).toBe("—");
    expect(modelLabel("opencode-go", "deepseek-v4.1-flash")).toBe(
      "opencode-go/deepseek-v4.1-flash",
    );
  });

  it("clasifica estados de fábrica", () => {
    expect(statusClass("done")).toBe("badge-success");
    expect(statusClass("budget_rejected")).toBe("badge-danger");
    expect(statusClass("running")).toBe("badge-warning");
    expect(statusClass("otro")).toBe("badge");
  });

  it("calcula porcentajes sin dividir por cero", () => {
    expect(percent(1, 4)).toBe(25);
    expect(percent(1, 0)).toBe(0);
  });
});
