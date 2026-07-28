import cors from "cors";
import express from "express";
import type { ServerConfig } from "./config";

export function createApp(config: ServerConfig) {
  const app = express();

  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      provider: config.provider,
      model: config.model,
      apiKeyConfigured: config.apiKey.length > 0,
      mockMode: config.mockMode,
    });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  return app;
}
