import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

/** Mirrors the rewrites in vercel.json. */
function cardUrl(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "s") return null;
  const [, kind, round, mission, account] = parts;
  if (kind === "r") return `/api/card?html=1&kind=round&round=${round}`;
  if (kind === "m") return `/api/card?html=1&kind=mission&round=${round}&mission=${mission}`;
  if (kind === "p") return `/api/card?html=1&kind=receipt&round=${round}&mission=${mission}&account=${account}`;
  return null;
}

/** Serves the API routes during local development, the way Vercel serves them when hosted. */
function localApi(): Plugin {
  return {
    name: "bonfire-local-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url ?? "";
        const target = path.startsWith("/api/card") ? path : cardUrl(path);
        if (!target) return next();
        try {
          const mod = await server.ssrLoadModule("/api/card.ts");
          const response: Response = await mod.GET(new Request(`http://${req.headers.host}${target}`));
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          next(error as Error);
        }
      });
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

const DELIVERIES = join(import.meta.dirname, "../../deliveries");
const DELIVERED = /\.(zip|mp4)$/;

function deliveredFiles(dir = DELIVERIES): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? deliveredFiles(join(dir, entry.name)) : DELIVERED.test(entry.name) ? [join(dir, entry.name)] : [],
  );
}

/** Serves delivered work at /deliveries/..., byte for byte as committed, so the site can check it against the chain. */
function deliveries(): Plugin {
  const served = (file: string) => `deliveries/${relative(DELIVERIES, file).split("\\").join("/")}`;
  return {
    name: "bonfire-deliveries",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = deliveredFiles().find((f) => `/${served(f)}` === req.url);
        if (!file) return next();
        res.setHeader("content-type", file.endsWith(".mp4") ? "video/mp4" : "application/zip");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const file of deliveredFiles()) this.emitFile({ type: "asset", fileName: served(file), source: readFileSync(file) });
    },
  };
}

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), "GUEST_"));
  return { plugins: [react(), localApi(), deliveries()] };
});
