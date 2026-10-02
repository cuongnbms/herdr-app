import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ quotaFetch: vi.fn() }));
import { quotaFetch } from "../lib/ipc";
import type { QuotaOutcome, QuotaProvider } from "../lib/types";
import { initialSlots, useQuota } from "../quota/store";
import { QuotaColumn } from "./QuotaColumn";

const fetchMock = vi.mocked(quotaFetch);
const card = (name: string) => screen.getByText(name).closest("li") as HTMLElement;

describe("QuotaColumn", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useQuota.setState({ slots: initialSlots() });
  });

  it("shows every Provider with its state after fetching on mount", async () => {
    const now = Date.now();
    const outcomes: Record<QuotaProvider, QuotaOutcome> = {
      claude: { kind: "ok", fetchedAt: now, windows: [
        { label: "5h", usedPercent: 19, resetsAt: now + (3_600 + 36 * 60) * 1000 + 500, durationSecs: 18_000 },
        { label: "week", usedPercent: 95, resetsAt: null, durationSecs: null },
      ] },
      codex: { kind: "notSignedIn" },
      opencodeGo: { kind: "noSubscription" },
      grok: { kind: "signInExpired" },
    };
    fetchMock.mockImplementation(async (p) => outcomes[p]);
    render(<QuotaColumn />);
    const col = screen.getByRole("region", { name: "Quota" });
    await waitFor(() => expect(within(col).getByText("19%")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const names = within(col).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(names[0]).toContain("Claude");
    expect(names[1]).toContain("Codex");
    expect(names[2]).toContain("OpenCode Go");
    expect(names[3]).toContain("Grok");
    expect(within(card("Claude")).getByText(/1h36m/)).toBeTruthy();
    expect(within(card("Claude")).getByText("95%").className).toContain("strong");
    expect(within(card("Codex")).getByText("not signed in")).toBeTruthy();
    expect(within(card("OpenCode Go")).getByText("no Go subscription")).toBeTruthy();
    expect(within(card("Grok")).getByText("sign-in expired — run grok")).toBeTruthy();
  });

  it("keeps the last numbers dimmed when sign-in expires", async () => {
    const fetchedAt = Date.now() - 3 * 3_600_000;
    useQuota.setState((s) => ({ slots: { ...s.slots, grok: { ...s.slots.grok, entry: { kind: "ok", report: { fetchedAt, windows: [
      { label: "week", usedPercent: 100, resetsAt: null, durationSecs: null } ] } } } } }));
    fetchMock.mockImplementation(async (p) => (p === "grok" ? { kind: "signInExpired" } : { kind: "notSignedIn" }));
    render(<QuotaColumn />);
    await waitFor(() => expect(within(card("Grok")).getByText(/sign-in expired — run grok/)).toBeTruthy());
    expect(within(card("Grok")).getByText(/updated 3h ago/)).toBeTruthy();
    expect(within(card("Grok")).getByText("100%").closest(".dash-quota-stale")).toBeTruthy();
  });

  it("refreshes by hand", async () => {
    fetchMock.mockResolvedValue({ kind: "notSignedIn" });
    render(<QuotaColumn />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(useQuota.getState().slots.grok.inFlight).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Refresh quota" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
  });
});
