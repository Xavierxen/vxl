import { Elysia } from "elysia";
import { env } from "../../../core/runtime";
import anivexaWorker, { PROVIDER_NAMES, ROUTES } from "./index.js";

const API_BASE_PATH = env.BASE_PATH || "/api";
const ROUTE_PATH = `${API_BASE_PATH}/anime/anivexa`;
const BASE_PATH = "/anime/anivexa";

export const anivexaRoutes = new Elysia({ prefix: "/anivexa" })
  .get(
    "/",
    () => ({
      service: "anivexa",
      description: "Anivexa — multi-provider anime episode & stream API (AniList-ID-based)",
      version: "2.2.1",
      providers: PROVIDER_NAMES,
      endpoints: ROUTES.map((route) => `GET ${ROUTE_PATH}${route}`),
    }),
    { detail: { tags: ["anime"], summary: "Anivexa — Provider Overview" } },
  )
  .get("/*", ({ request }) => {
    const url = new URL(request.url);
    url.pathname = url.pathname.startsWith(ROUTE_PATH)
      ? url.pathname.slice(ROUTE_PATH.length) || "/"
      : url.pathname;
    return anivexaWorker.fetch(
      new Request(url, { headers: request.headers, signal: request.signal }),
      {
        basePath: BASE_PATH,
      },
    );
  });
