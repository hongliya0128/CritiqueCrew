import { BailianClient } from "../server/bailian-client";
import { loadConfig } from "../server/config";

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.mockMode) {
    throw new Error("当前 MOCK_LLM=true。真实模型测试前请在本地 .env 中改为 MOCK_LLM=false。");
  }
  if (!config.apiKey) {
    throw new Error(
      "DASHSCOPE_API_KEY 未配置。请只在本地 .env 中填写，不要发送到聊天或提交到 Git。",
    );
  }

  const client = new BailianClient(config);
  const result = await client.complete({
    model: config.model,
    jsonMode: true,
    messages: [
      {
        role: "system",
        content: "你是 CritiqueCrew 连接测试助手。请只输出合法 JSON。",
      },
      {
        role: "user",
        content:
          "请返回 JSON：包含 status='ok'、modelPurpose='ui-review' 和一句简短中文 message。",
      },
    ],
  });

  const parsedContent = JSON.parse(result.content) as unknown;
  console.log("百炼最小请求成功");
  console.log(`模型：${result.model}`);
  console.log(`耗时：${result.latencyMs}ms`);
  console.log(`Token：${result.usage.totalTokens ?? "未返回"}`);
  console.log(`响应：${JSON.stringify(parsedContent)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "模型测试失败。");
  process.exitCode = 1;
});
