import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => new ArrayBuffer(4)), Channel: class {} }));
import { invoke } from "@tauri-apps/api/core";
import { ImageView } from "./ImageView";

describe("ImageView", () => {
  // jsdom has no object URLs.
  const { createObjectURL, revokeObjectURL } = URL;
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });
  it("fetches the image again when its mtime changes", async () => {
    const { rerender, findByRole } = render(<ImageView machineId="local" root="/r" rel="a.png" mtime={1} />);
    await findByRole("img");
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    rerender(<ImageView machineId="local" root="/r" rel="a.png" mtime={2} />);
    await findByRole("img");
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
  });
});
