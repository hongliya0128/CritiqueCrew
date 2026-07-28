import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createApp(config);

app.listen(config.port, "127.0.0.1", () => {
  console.log(`CritiqueCrew proxy listening on http://localhost:${config.port}`);
  console.log(
    `Provider: ${config.provider} | Model: ${config.model} | Mock: ${config.mockMode} | API key configured: ${config.apiKey.length > 0}`,
  );
});
