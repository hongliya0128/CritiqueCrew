export type HealthResponse = {
  status: "ok";
  provider: string;
  model: string;
  apiKeyConfigured: boolean;
  mockMode: boolean;
};
