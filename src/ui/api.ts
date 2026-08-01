import type { HealthResponse } from "../shared/health";
import type { ReviewRequest, ReviewResponse } from "../shared/review";

const PROXY_BASE_URL = "http://localhost:8787";
const REVIEW_REQUEST_TIMEOUT_MS = 150_000;

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

export async function requestReview(payload: ReviewRequest): Promise<ReviewResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REVIEW_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${PROXY_BASE_URL}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`评审请求失败（HTTP ${response.status}）。`);
    return (await response.json()) as ReviewResponse;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("评审等待超过 150 秒，请检查百炼服务状态后重试；无需连续点击评审按钮。");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
