import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const envSchema = z.object({
  LLM_PROVIDER: z.string().trim().min(1).default("bailian"),
  DASHSCOPE_API_KEY: z.string().trim().default(""),
  DASHSCOPE_BASE_URL: z
    .string()
    .url()
    .default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  BAILIAN_MODEL: z.string().trim().min(1).default("qwen3.7-plus"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  MOCK_LLM: z.string().trim().default("true"),
});

export type ServerConfig = {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  port: number;
  mockMode: boolean;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.parse(environment);
  return {
    provider: parsed.LLM_PROVIDER,
    apiKey: parsed.DASHSCOPE_API_KEY,
    baseUrl: parsed.DASHSCOPE_BASE_URL.replace(/\/$/, ""),
    model: parsed.BAILIAN_MODEL,
    port: parsed.PORT,
    mockMode: parsed.MOCK_LLM.toLowerCase() !== "false",
  };
}
