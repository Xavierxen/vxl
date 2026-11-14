import { Elysia } from "elysia";
import { vidfastRoutes } from "./vidfast/route";
import { vidcoreRoutes } from "./vidcore/route";

export const streamRoutes = new Elysia({ prefix: "/stream" })
  .get(
    "/",
    () => {
      return {
        service: "stream",
        description: "Unified direct streaming API — provider-isolated route architecture",
        providers: ["vidcore", "vidfast"],
        endpoints: {
          vidcore: [
            "GET /stream/vidcore                                 → Provider Status and info",
            "GET /stream/vidcore/watch?type=movie&id=550         → Fetch extracted sources & subs (Param based)",
            "GET /stream/vidcore/watch?type=tv&id=550&s=1&e=1    → Fetch extracted sources & subs (Param based)",
            "GET /stream/vidcore/movie/:id                       → Fetch extracted sources & subs (Path based)",
            "GET /stream/vidcore/tv/:id/:season/:episode         → Fetch extracted sources & subs (Path based)",
            "NOTE: Returns cleanly extracted HLS streams routed through the internal proxy.",
          ],
          vidfast: [
            "GET /stream/vidfast                                 → Provider Status and info",
            "GET /stream/vidfast/watch?type=movie&id=550         → Fetch extracted sources & subs (Param based)",
            "GET /stream/vidfast/watch?type=tv&id=550&s=1&e=1    → Fetch extracted sources & subs (Param based)",
            "GET /stream/vidfast/movie/:id                       → Fetch extracted sources & subs (Path based)",
            "GET /stream/vidfast/tv/:id/:season/:episode         → Fetch extracted sources & subs (Path based)",
            "NOTE: Returns cleanly extracted HLS streams routed through the internal proxy.",
          ],
        },
      };
    },
    {
      detail: {
        tags: ["stream"],
        summary: "Stream API Overview",
      },
    },
  )
  .use(vidfastRoutes)
  .use(vidcoreRoutes);
