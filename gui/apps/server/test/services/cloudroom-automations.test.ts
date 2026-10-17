import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { createThread, cloudroomThreads } from "@cloudroom/db";

it("routes self-hosted loops to Core, maps agent sessions, and reports old Core support", async () => {
  const harness = await createTestAppHarness();
  const service = cloudroom(harness.deps);
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const thread = createThread(harness.db, harness.deps.hub, { projectId: project.id, executionTarget: "cloud", providerId: "codex", status: "idle" });
  const calls: Record<string, unknown>[] = [];
  let supported = true;
  const id = "11111111-1111-4111-8111-111111111111";
  const automation = { id, thread_id: "cr_native", session_id: "cr_native", name: "Check", enabled: true };
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    expect(req.headers.authorization).toBe(`Bearer ${"x".repeat(40)}`);
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: "/code", stop: true, resume: true, launch_settings: true, automations: supported, harnesses: [{ id: "codex", model: "test" }] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/automations") {
      let text = ""; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text) as Record<string, unknown>;
      calls.push(body);
      return json(body.action === "list" ? { automations: [automation] } : body.action === "delete" ? { ok: true } : { automation }, 202);
    }
    json({}, 404);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const url = `http://127.0.0.1:${address.port}`;
  const request = (body: unknown) => harness.app.request("/api/v1/cloudroom/account/automations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    await service.configure({ url, token: "x".repeat(40) });
    harness.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: url, sessionId: "cr_native", startRequestId: "native", model: "test", reasoning: "medium" }).run();
    const listed = await request({ action: "list" });
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(await listed.json()).toMatchObject({ scheduler: "core", automations: [{ id, thread_id: thread.id }] });
    const created = await request({ action: "create", thread: thread.id, name: "Check", prompt: "Review issues", cron: "*/15 * * * *", new_thread: false });
    expect(created.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ action: "create", thread: thread.id, session: "cr_native", new_thread: false });
    await request({ action: "list", thread: thread.id });
    expect(calls.at(-1)).toEqual({ action: "list", session: "cr_native" });
    for (const body of [{ action: "update", id, enabled: false }, { action: "run", id }, { action: "delete", id }]) {
      expect((await request(body)).status).toBe(200);
      expect(calls.at(-1)).toEqual(body);
    }
    supported = false;
    const old = await request({ action: "list" });
    expect(old.status).toBe(409);
    expect(await old.text()).toContain("does not support loops");
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())); await harness.cleanup();
  }
});

it("returns an empty list without requiring an account when no Core is configured", async () => {
  const harness = await createTestAppHarness();
  try {
    expect(await cloudroom(harness.deps).automations({ action: "list" })).toEqual({ automations: [], scheduler: "none" });
  } finally { cloudroom(harness.deps).stop(); await harness.cleanup(); }
});
