import { describe, expect, it } from "vitest";
import { findCommand, parseSlash, suggestCommands } from "./commands";

describe("parseSlash", () => {
  it("parsea nombre y argumento", () => {
    expect(parseSlash("/cd ~/Projects")).toEqual({ name: "cd", arg: "~/Projects" });
    expect(parseSlash("  /models  opencode-go/x  ")).toEqual({
      name: "models",
      arg: "opencode-go/x",
    });
  });

  it("ignora texto que no es un comando", () => {
    expect(parseSlash("hola /cd")).toBeNull();
    expect(parseSlash("/")).toBeNull();
    expect(parseSlash("/1foo")).toBeNull();
  });
});

describe("suggestCommands", () => {
  it("sugiere por prefijo y solo mientras se escribe el nombre", () => {
    expect(suggestCommands("/mo").map((command) => command.name)).toEqual(["models"]);
    expect(suggestCommands("/co").map((command) => command.name)).toEqual(["continue"]);
    expect(suggestCommands("/ch").map((command) => command.name)).toEqual(["checkpoint"]);
    expect(suggestCommands("/cd foo")).toEqual([]);
    expect(suggestCommands("texto")).toEqual([]);
  });

  it("devuelve todos con una barra sola", () => {
    expect(suggestCommands("/").length).toBeGreaterThanOrEqual(7);
  });
});

describe("findCommand", () => {
  it("encuentra por nombre", () => {
    expect(findCommand("status")?.usage).toBe("/status");
    expect(findCommand("nope")).toBeUndefined();
  });
});
