import type { HealthResponse } from "../shared/health";

const PROXY_BASE_URL = "http://localhost:8787";

export async function getHealth(): Promise<HealthResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(`${PROXY_BASE_URL}/health`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Health check failed: ${response.status}`);

    const data = (await response.json()) as Partial<HealthResponse>;
    if (
      data.status !== "ok" ||
      typeof data.provider !== "string" ||
      typeof data.model !== "string" ||
      typeof data.apiKeyConfigured !== "boolean" ||
      typeof data.mockMode !== "boolean"
    ) {
      throw new Error("Health response shape is invalid.");
    }
    return data as HealthResponse;
  } finally {
    window.clearTimeout(timeout);
  }
}
