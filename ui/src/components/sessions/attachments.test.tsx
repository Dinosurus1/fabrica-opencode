import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFileAttachments } from "./attachments";

function file(name: string, content = "hola", type = "text/plain") {
  return new File([content], name, { type });
}

describe("useFileAttachments", () => {
  it("lee un archivo y lo puede quitar", async () => {
    const { result } = renderHook(() => useFileAttachments());
    await act(async () => {
      await result.current.add([file("nota.txt")]);
    });
    expect(result.current.files).toHaveLength(1);
    expect(result.current.files[0]?.name).toBe("nota.txt");
    expect(result.current.files[0]?.dataUrl).toMatch(/^data:text\/plain;base64,/);

    act(() => {
      result.current.remove(result.current.files[0]!.id);
    });
    expect(result.current.files).toHaveLength(0);
  });

  it("rechaza archivos que superan el límite", async () => {
    const { result } = renderHook(() => useFileAttachments());
    const huge = file("grande.bin", "x");
    Object.defineProperty(huge, "size", { value: 9 * 1024 * 1024 });
    await act(async () => {
      await result.current.add([huge]);
    });
    expect(result.current.files).toHaveLength(0);
    expect(result.current.error).toMatch(/supera/);
  });

  it("descarta el resultado si la sesión cambió durante la lectura", async () => {
    const { result } = renderHook(() => useFileAttachments());
    await act(async () => {
      await result.current.add([file("tarde.txt")], { guard: () => false });
    });
    expect(result.current.files).toHaveLength(0);
  });
});
