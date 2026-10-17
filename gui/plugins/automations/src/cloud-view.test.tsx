// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => rpc, useBbNavigate: () => ({ toThread: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { useCloudAutomations } from "../cloud-view.js";
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("exposes Core connection failures and recovers without hiding saved loops", async () => {
  rpc.call.mockRejectedValueOnce(new Error("Core is offline"));
  const { result } = renderHook(() => useCloudAutomations());
  await waitFor(() => expect(result.current.error).toBe("Core is offline"));
  rpc.call.mockResolvedValueOnce({ scheduler: "core", automations: [{ id: "loop", name: "Check" }] });
  act(() => result.current.onRetry());
  await waitFor(() => expect(result.current.scheduler).toBe("core"));
  expect(result.current.error).toBeNull();
  expect(result.current.rows).toHaveLength(1);
  rpc.call.mockRejectedValueOnce(new Error("Connection lost"));
  act(() => result.current.onRetry());
  await waitFor(() => expect(result.current.error).toBe("Connection lost"));
  expect(result.current.rows).toHaveLength(1);
});
