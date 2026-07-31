import cors from "cors";
import express from "express";
import type { ServerConfig } from "./config";
import { ReviewService } from "./review-service";
import type { ReviewRequest } from "../src/shared/review";

export function createApp(config: ServerConfig) {
  const app = express();
  const reviewService = new ReviewService(config);

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

  app.post("/api/review", async (request, response) => {
    const body = request.body as Partial<ReviewRequest>;
    if (!body.scan || !Array.isArray(body.scan.nodes) || !body.rules || !Array.isArray(body.rules.issues)) {
      response.status(400).json({ error: "Invalid review request." });
      return;
    }
    response.json(await reviewService.review(body as ReviewRequest));
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  return app;
}
