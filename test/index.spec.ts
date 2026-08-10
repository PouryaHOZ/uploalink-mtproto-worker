import {
        env,
        createExecutionContext,
        waitOnExecutionContext,
        SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Worker health check", () => {
        it("responds with healthy status (unit style)", async () => {
                const request = new IncomingRequest("http://example.com/health");
                const ctx = createExecutionContext();
                const response = await worker.fetch(request, env, ctx);
                await waitOnExecutionContext(ctx);
                expect(response.status).toBe(200);
                const body = await response.json();
                expect(body).toEqual({ status: "healthy" });
        });

        it("responds with healthy status (integration style)", async () => {
                const response = await SELF.fetch("https://example.com/health");
                expect(response.status).toBe(200);
                expect(await response.text()).toMatchInlineSnapshot(`"{"status":"healthy"}"`);
        });

        it("returns 404 for unknown paths", async () => {
                const response = await SELF.fetch("https://example.com/nonexistent");
                expect(response.status).toBe(404);
        });
});
