import { beforeEach, describe, expect, it } from "vitest";
import {
  baseTitle,
  generationFromTitle,
  lineageChain,
  registerChild,
  titleForHandoff,
} from "./lineage";

beforeEach(() => {
  localStorage.clear();
});

describe("títulos de linaje", () => {
  it("quita las continuaciones anidadas", () => {
    expect(baseTitle("Continuación · Continuación · Actualización de Factory")).toBe(
      "Actualización de Factory",
    );
    expect(generationFromTitle("Continuación · Continuación · Actualización de Factory")).toBe(2);
    expect(generationFromTitle("Actualización de Factory")).toBe(0);
  });

  it("genera parte N sin repetir Continuación", () => {
    expect(titleForHandoff("Actualización de Factory para OpenCode v2", 2)).toBe(
      "Actualización de Factory para OpenCode v2 · parte 3",
    );
    expect(titleForHandoff("x".repeat(80), 0)).toContain("· parte 1");
  });
});

describe("registro de linaje", () => {
  it("encadena raíz → hija → nieta", () => {
    registerChild("root", "Actualización de Factory", "hija", "Actualización de Factory");
    registerChild("hija", "Actualización de Factory · parte 2", "nieta", "Actualización de Factory");
    const chain = lineageChain("nieta");
    expect(chain.map((entry) => entry.generation)).toEqual([0, 1, 2]);
    expect(chain[2].title).toBe("Actualización de Factory · parte 3");
  });

  it("una sesión con título anidado se trata como raíz de generación 2", () => {
    registerChild(
      "vieja",
      "Continuación · Continuación · Actualización de Factory",
      "nueva",
      "Actualización de Factory",
    );
    expect(lineageChain("nueva")[1].title).toBe("Actualización de Factory · parte 4");
  });
});
