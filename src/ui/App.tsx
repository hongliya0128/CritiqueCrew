import { useEffect, useState } from "preact/hooks";
import type {
  NodeSnapshot,
  PluginMessage,
  ScanResult,
  ScanScope,
  SelectionSummary,
  UIMessage,
} from "../shared/messages";

const NODE_PREVIEW_LIMIT = 20;

const emptySelection: SelectionSummary = {
  count: 0,
  names: [],
  canScanSelection: false,
};

function send(message: PluginMessage): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

function channelToHex(value: number): string {
  return Math.round(Math.max(0, Math.min(1, value)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}

function fillLabel(node: NodeSnapshot): string {
  const fill = node.fills[0];
  if (!fill) return "无纯色填充";
  const hex = `#${channelToHex(fill.r)}${channelToHex(fill.g)}${channelToHex(fill.b)}`;
  const alpha = fill.a < 1 ? ` / ${Math.round(fill.a * 100)}%` : "";
  const more = node.fills.length > 1 ? ` +${node.fills.length - 1}` : "";
  return `${hex}${alpha}${more}`;
}

function optionalNumber(value: number | "mixed" | null, suffix = ""): string {
  if (value === "mixed") return "混合";
  return value === null ? "—" : `${value}${suffix}`;
}

export function App() {
  const [selection, setSelection] = useState(emptySelection);
  const [status, setStatus] = useState("正在连接 Figma 主线程...");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [nodeQuery, setNodeQuery] = useState("");

  const normalizedQuery = nodeQuery.trim().toLocaleLowerCase();
  const matchingNodes = scanResult
    ? scanResult.nodes.filter((node) => {
        if (!normalizedQuery) return true;
        return (
          node.name.toLocaleLowerCase().includes(normalizedQuery) ||
          node.id.toLocaleLowerCase().includes(normalizedQuery) ||
          node.type.toLocaleLowerCase().includes(normalizedQuery)
        );
      })
    : [];
  const previewNodes = matchingNodes.slice(0, NODE_PREVIEW_LIMIT);

  useEffect(() => {
    const receive = (event: MessageEvent<{ pluginMessage?: UIMessage }>) => {
      const message = event.data.pluginMessage;
      if (!message) return;

      if (message.type === "SELECTION_CHANGED") {
        setSelection(message.selection);
        setStatus("已同步当前选中状态。");
      }

      if (message.type === "SCAN_RESULT") {
        setScanResult(message.result);
        setNodeQuery("");
        setStatus(
          message.result.truncated
            ? `已读取前 ${message.result.nodeCount} 个可见节点，结果已截断。`
            : `节点树读取完成，共 ${message.result.nodeCount} 个可见节点。`,
        );
      }

      if (message.type === "PLUGIN_ERROR") {
        setStatus(message.message);
      }
    };

    window.addEventListener("message", receive);
    send({ type: "UI_READY" });
    return () => window.removeEventListener("message", receive);
  }, []);

  function requestScan(scope: ScanScope): void {
    setStatus("正在读取节点树...");
    setScanResult(null);
    setNodeQuery("");
    send({ type: "SCAN_REQUEST", scope });
  }

  return (
    <main class="app-shell">
      <header>
        <p class="eyebrow">CRITIQUECREW</p>
        <h1>多视角 UI 评估</h1>
        <p class="subtitle">第一阶段：Figma 节点树读取</p>
      </header>

      <section class="selection-card" aria-label="当前选择">
        <span>当前选择</span>
        <strong>{selection.count} 个图层</strong>
        <p>{selection.names.length ? selection.names.join("、") : "尚未选择图层。"}</p>
        <small>
          {selection.canScanSelection
            ? "当前选择可作为评估范围。"
            : "选中一个 Frame、Component、Instance 或 Section，或评估当前页面。"}
        </small>
      </section>

      <section class="status-card" aria-live="polite">
        <span>状态</span>
        <p>{status}</p>
      </section>

      {scanResult && (
        <>
          <section class="scan-card" aria-label="扫描结果">
            <div>
              <span>扫描范围</span>
              <strong>{scanResult.rootName}</strong>
            </div>
            <div>
              <span>根节点类型</span>
              <strong>{scanResult.rootType}</strong>
            </div>
            <div>
              <span>可见节点</span>
              <strong>{scanResult.nodeCount}</strong>
            </div>
          </section>

          <details class="node-preview">
            <summary>
              <span>节点数据预览</span>
              <small>{matchingNodes.length} 条</small>
            </summary>
            <div class="node-preview-body">
              <label class="node-search">
                <span>搜索节点</span>
                <input
                  type="search"
                  value={nodeQuery}
                  placeholder="输入名称、ID 或类型"
                  onInput={(event) => setNodeQuery(event.currentTarget.value)}
                />
              </label>
              <p class="preview-hint">
                {matchingNodes.length > NODE_PREVIEW_LIMIT
                  ? `为保证性能，当前显示前 ${NODE_PREVIEW_LIMIT} 条，共匹配 ${matchingNodes.length} 条。`
                  : `当前显示 ${matchingNodes.length} 条节点数据。`}
              </p>

              <div class="node-list">
                {previewNodes.map((node) => (
                  <article class="node-item" key={node.id}>
                    <header>
                      <div>
                        <strong title={node.name}>{node.name}</strong>
                        <p class="node-id">
                          <span>节点 ID</span>
                          <code title={node.id}>{node.id}</code>
                        </p>
                      </div>
                      <span class="node-type">{node.type}</span>
                    </header>
                    <dl>
                      <div class="property-row">
                        <dt>类型</dt>
                        <dd>{node.type}</dd>
                      </div>
                      <div class="property-row">
                        <dt>尺寸</dt>
                        <dd>宽 {node.width}px × 高 {node.height}px</dd>
                      </div>
                      <div class="property-row">
                        <dt>相对位置</dt>
                        <dd>X {node.x}px，Y {node.y}px</dd>
                      </div>
                      <div class="property-row">
                        <dt>绝对位置</dt>
                        <dd>
                          {node.absoluteX === null || node.absoluteY === null
                            ? "—"
                            : `X ${node.absoluteX}px，Y ${node.absoluteY}px`}
                        </dd>
                      </div>
                      <div class="property-row">
                        <dt>纯色填充</dt>
                        <dd class="fill-value">
                          {node.fills[0] && (
                            <i
                              aria-hidden="true"
                              style={{
                                backgroundColor: `rgba(${node.fills[0].r * 255}, ${node.fills[0].g * 255}, ${node.fills[0].b * 255}, ${node.fills[0].a})`,
                              }}
                            />
                          )}
                          {fillLabel(node)}
                        </dd>
                      </div>
                      <div class="property-row">
                        <dt>字号</dt>
                        <dd>{optionalNumber(node.fontSize, "px")}</dd>
                      </div>
                      <div class="property-row">
                        <dt>圆角</dt>
                        <dd>{optionalNumber(node.cornerRadius, "px")}</dd>
                      </div>
                      <div class="property-row relationship-row">
                        <dt>层级关系</dt>
                        <dd>
                          <span>深度 {node.depth}</span>
                          <span title={node.parentId ?? "扫描根节点"}>
                            父节点 {node.parentId ?? "无（扫描根节点）"}
                          </span>
                          <span>子节点 {node.childIds.length} 个</span>
                        </dd>
                      </div>
                    </dl>
                  </article>
                ))}
                {previewNodes.length === 0 && <p class="empty-preview">没有匹配的节点。</p>}
              </div>
            </div>
          </details>
        </>
      )}

      <div class="actions scan-actions">
        <button
          class="primary"
          type="button"
          disabled={!selection.canScanSelection}
          onClick={() => requestScan("selection")}
        >
          扫描选中范围
        </button>
        <button class="secondary page-button" type="button" onClick={() => requestScan("page")}>
          扫描当前页面
        </button>
      </div>
      <button class="close-button" type="button" onClick={() => send({ type: "CLOSE_PLUGIN" })}>
        关闭插件
      </button>
    </main>
  );
}
