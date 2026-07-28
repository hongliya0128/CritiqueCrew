import { build } from "esbuild";
import { watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const uiHtmlPath = path.join(root, "src", "ui", "index.html");

async function buildUiHtml() {
  const result = await build({
    entryPoints: [path.join(root, "src", "ui", "main.tsx")],
    bundle: true,
    format: "iife",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: "preact",
    outdir: dist,
    write: false,
  });
  const script = result.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
  const styles = result.outputFiles.find((file) => file.path.endsWith(".css"))?.text;
  if (!script || !styles) throw new Error("UI bundle did not produce JavaScript and CSS.");

  const template = await readFile(uiHtmlPath, "utf8");
  return template
    .replace("<!-- STYLES -->", `<style>${styles}</style>`)
    .replace("<!-- SCRIPT -->", `<script>${script}</script>`);
}

async function buildAll() {
  const html = await buildUiHtml();
  await writeFile(path.join(dist, "ui.html"), html);
  await build({
    entryPoints: [path.join(root, "src", "main", "code.ts")],
    bundle: true,
    format: "iife",
    target: "es2020",
    outfile: path.join(dist, "code.js"),
    define: { __html__: JSON.stringify(html) },
  });
  console.log("Built CritiqueCrew to dist/.");
}

await mkdir(dist, { recursive: true });
await buildAll();

if (process.argv.includes("--watch")) {
  console.log("Watching CritiqueCrew source files...");
  let timer;
  watch(path.join(root, "src"), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      buildAll().catch((error) => console.error(error));
    }, 100);
  });
  await new Promise(() => {});
} else {
  process.exit(0);
}
