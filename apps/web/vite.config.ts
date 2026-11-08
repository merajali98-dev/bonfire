import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

/** Serves the guest route during local development, the way Vercel serves it when hosted. */
function guestApi(): Plugin {
  return {
    name: "bonfire-guest-api",
    configureServer(server) {
      server.middlewares.use("/api/guest", async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const mod = await server.ssrLoadModule("/api/guest.ts");
        const response: Response = await mod.POST(
          new Request("http://localhost/api/guest", {
            method: "POST",
            headers: { "x-forwarded-for": req.socket.remoteAddress ?? "local" },
            body: Buffer.concat(chunks),
          }),
        );
        res.statusCode = response.status;
        res.setHeader("content-type", "application/json");
        res.end(await response.text());
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), "GUEST_"));
  return { plugins: [react(), guestApi()] };
});
