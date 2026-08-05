import { useEffect, useRef, useState } from "preact/hooks";
import {
  chooseReverseLocateTarget,
  type ReviewAnnotationIssue,
} from "../shared/annotations";
import type { HealthResponse } from "../shared/health";
import {
  buildEvaluationReport,
  createReportFilename,
  serializeReport,
  type ReportFormat,
} from "../shared/report-export";
import type { ReviewAspect, ReviewDirection, ReviewerRole, ReviewResponse } from "../shared/review";
import { getReviewBasis } from "../shared/review-basis";
import type {
  PluginMessage,
  RuleId,
  ScanResult,
  ScanScope,
  SelectionSummary,
  UIMessage,
} from "../shared/messages";
import { checkRules } from "../shared/rule-engine";
import { getHealth, requestReview } from "./api";

const emptySelection: SelectionSummary = {
  count: 0,
  names: [],
  selectedNodeId: null,
  canScanSelection: false,
  pageId: "",
  pageName: "",
};

function send(message: PluginMessage): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

function shortScopeName(name: string): string {
  return name.split("/").find((part) => /^A\d+/i.test(part)) ?? name;
}

const ruleFilters: { id: RuleId | "all"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "color-contrast", label: "对比度" },
  { id: "font-size", label: "字号" },
  { id: "target-size", label: "点击区域" },
];

const reviewRoleLabels = {
  visual: "视觉设计师",
  accessibility: "无障碍专家",
  interaction: "交互设计师",
} as const;

const reviewRoleShortLabels = {
  visual: "视觉",
  accessibility: "无障碍",
  interaction: "交互",
} as const;

const coordinationPerspectiveLabels = {
  visual: "视觉设计",
  accessibility: "无障碍",
  interaction: "交互流程",
} as const;

const reviewSeverityLabels = {
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级",
} as const;

const reviewAspectLabels: Record<ReviewAspect, string> = {
  "visual-prominence": "视觉显著性",
  "information-density": "信息密度",
  readability: "可读性",
  "interaction-entry": "操作入口",
  "status-feedback": "状态反馈",
  "error-prevention": "误操作防护",
  other: "其他议题",
};

const reviewDirectionLabels: Record<ReviewDirection, string> = {
  strengthen: "强化",
  weaken: "弱化",
  add: "增加",
  remove: "移除",
  retain: "保留",
  restructure: "重构",
  unspecified: "未指定",
};

export function App() {
  const [selection, setSelection] = useState(emptySelection);
  const [status, setStatus] = useState("正在连接 Figma 主线程...");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [ruleCheck, setRuleCheck] = useState<ReturnType<typeof checkRules> | null>(null);
  const [activeIssueId, setActiveIssueId] = useState<string | null>(null);
  const [canvasSelectedNodeId, setCanvasSelectedNodeId] = useState<string | null>(null);
  const [canvasSelectionRevision, setCanvasSelectionRevision] = useState(0);
  const [ruleFilter, setRuleFilter] = useState<RuleId | "all">("all");
  const [proxyHealth, setProxyHealth] = useState<HealthResponse | null>(null);
  const [proxyError, setProxyError] = useState(false);
  const [reviewResponse, setReviewResponse] = useState<ReviewResponse | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [activeReviewIssueId, setActiveReviewIssueId] = useState<string | null>(null);
  const issueCardRefs = useRef(new Map<string, HTMLElement>());
  const reviewIssueCardRefs = useRef(new Map<string, HTMLElement>());
  const reviewerCardRefs = useRef(new Map<ReviewerRole, HTMLDetailsElement>());
  const agentReviewPanelRef = useRef<HTMLDetailsElement>(null);
  const ruleResultsPanelRef = useRef<HTMLDetailsElement>(null);
  const annotatedRuleNodeIdsRef = useRef<Set<string>>(new Set());
  const annotatedReviewNodeIdsRef = useRef<Set<string>>(new Set());
  const suppressedReverseLocateNodeIdRef = useRef<string | null>(null);
  const preserveForwardCardSelectionRef = useRef(false);

  const visibleIssues = ruleCheck
    ? ruleCheck.issues.filter((issue) => ruleFilter === "all" || issue.ruleId === ruleFilter)
    : [];
  const reviewAnnotationIssues: ReviewAnnotationIssue[] = reviewResponse && scanResult
    ? reviewResponse.reviews.flatMap((review) =>
        review.issues.map((issue) => ({
            nodeId: issue.nodeId ?? scanResult.rootId,
            nodeName: issue.nodeName ?? scanResult.rootName,
            role: review.role,
            severity: issue.severity,
            screenLevel: issue.nodeId === null,
          })),
      )
    : [];
  const reviewAnnotationNodeCount = new Set(reviewAnnotationIssues.map((issue) => issue.nodeId)).size;
  const reviewIssueCount = reviewResponse
    ? reviewResponse.reviews.reduce((total, review) => total + review.issues.length, 0)
    : 0;
  const selectedNodeIsInScan = Boolean(
    scanResult &&
    selection.selectedNodeId &&
    (selection.selectedNodeId === scanResult.rootId ||
      scanResult.nodes.some((node) => node.id === selection.selectedNodeId)),
  );
  const selectedPageChanged = Boolean(
    scanResult?.pageId &&
    selection.pageId &&
    scanResult.pageId !== selection.pageId,
  );
  const selectionOutsideScan = Boolean(
    scanResult &&
    (selectedPageChanged ||
      (selection.selectedNodeId && !selectedNodeIsInScan)),
  );
  const showSelectionWarning = selectionOutsideScan && !reviewing && !proxyError;
  const currentSelectionLabel = selection.names[0] || selection.pageName || "当前范围";
  const scanTargetShortName = scanResult ? shortScopeName(scanResult.rootName) : "";
  const proxyLabel = proxyHealth ? "百炼已连接" : proxyError ? "代理未连接" : "正在连接";
  const workflowGuide = proxyError
    ? {
        stage: "连接服务",
        message: "请先启动本地代理，连接成功后即可扫描与评审。",
      }
    : reviewing
      ? {
          stage: "评审进行中",
          message: "三位专家正在独立评审当前界面，请稍候。",
        }
      : showSelectionWarning
        ? {
            stage: "选择已变更",
            message: `当前选择为「${currentSelectionLabel}」，下方仍显示「${scanResult!.rootName}」的结果。评审新范围前请重新扫描。`,
          }
        : reviewResponse
        ? {
            stage: reviewResponse.incomplete ? "检查评审结果" : "评审已完成",
            message: "展开下方专家卡片，查看具体问题并定位到画布节点。",
          }
        : scanResult
          ? {
              stage: "下一步 · AI 评审",
              message: `已扫描「${scanResult.rootName}」，现在可以运行三位专家评审。`,
            }
          : selection.canScanSelection
            ? {
                stage: "下一步 · 扫描",
                message: `已选择「${selection.names[0] ?? "当前范围"}」，点击下方按钮开始扫描。`,
              }
            : selection.count > 0
              ? {
                  stage: "调整选择",
                  message: "请选择一个扫描范围（支持 Frame、Component、Instance、Section、Group）。",
                }
              : {
                  stage: "第一步 · 选择范围",
                  message: "先在 Figma 画布中选择一个需要评估的范围（支持 Frame、Component、Instance、Section、Group）。",
                };

  useEffect(() => {
    getHealth()
      .then((health) => {
        setProxyHealth(health);
        setProxyError(false);
      })
      .catch(() => {
        setProxyHealth(null);
        setProxyError(true);
      });
  }, []);

  useEffect(() => {
    const receive = (event: MessageEvent<{ pluginMessage?: UIMessage }>) => {
      const message = event.data.pluginMessage;
      if (!message) return;

      if (message.type === "SELECTION_CHANGED") {
        setSelection(message.selection);
        setCanvasSelectedNodeId(message.selection.selectedNodeId);
        setCanvasSelectionRevision((revision) => revision + 1);
        setStatus("已同步当前选中状态。");
      }

      if (message.type === "SCAN_RESULT") {
        setScanResult(message.result);
        setRuleCheck(checkRules(message.result.nodes));
        setActiveIssueId(null);
        setRuleFilter("all");
        setReviewResponse(null);
        setActiveReviewIssueId(null);
        annotatedRuleNodeIdsRef.current.clear();
        annotatedReviewNodeIdsRef.current.clear();
        setStatus(
          message.result.truncated
            ? `已读取前 ${message.result.nodeCount} 个可见节点，结果已截断。`
            : `节点树读取完成，共 ${message.result.nodeCount} 个可见节点。`,
        );
      }

      if (message.type === "NODE_LOCATED") {
        setStatus(`已定位到画布节点：${message.nodeName}。`);
      }

      if (message.type === "SCOPE_LOCATED") {
        setStatus(`已定位到评估范围：${message.rootName}。`);
      }

      if (message.type === "NODE_FOCUS_CLEARED") {
        setStatus("已取消节点定位。");
      }

      if (message.type === "ANNOTATIONS_CREATED") {
        annotatedRuleNodeIdsRef.current = new Set(message.nodeIds);
        setStatus(
          message.count > 0
            ? `已在画布中创建 ${message.count} 个规则问题标注。`
            : "未找到可标注的规则问题节点。",
        );
      }

      if (message.type === "ANNOTATIONS_CLEARED") {
        annotatedRuleNodeIdsRef.current.clear();
        setActiveIssueId(null);
        setStatus(message.count > 0 ? `已清除 ${message.count} 组画布标注。` : "当前没有可清除的画布标注。");
      }

      if (message.type === "REVIEW_ANNOTATIONS_CREATED") {
        annotatedReviewNodeIdsRef.current = new Set(message.nodeIds);
        setStatus(
          message.count > 0
            ? `已在画布中创建 ${message.count} 个 AI 评审问题标注。`
            : "未找到可标注的 AI 评审问题节点。",
        );
      }

      if (message.type === "REVIEW_ANNOTATIONS_CLEARED") {
        annotatedReviewNodeIdsRef.current.clear();
        setActiveReviewIssueId(null);
        setStatus(message.count > 0 ? "已清除 AI 评审问题标注。" : "当前没有可清除的 AI 评审标注。");
      }

      if (message.type === "PLUGIN_ERROR") {
        setActiveIssueId(null);
        setStatus(message.message);
      }

    };

    window.addEventListener("message", receive);
    send({ type: "UI_READY" });
    return () => window.removeEventListener("message", receive);
  }, []);

  useEffect(() => {
    if (!canvasSelectedNodeId) {
      setActiveIssueId(null);
      setActiveReviewIssueId(null);
      return;
    }

    const suppressedNodeId = suppressedReverseLocateNodeIdRef.current;
    if (suppressedNodeId) {
      suppressedReverseLocateNodeIdRef.current = null;
      if (suppressedNodeId === canvasSelectedNodeId) {
        if (preserveForwardCardSelectionRef.current) {
          preserveForwardCardSelectionRef.current = false;
          return;
        }
        setActiveIssueId(null);
        setActiveReviewIssueId(null);
        return;
      }
    }

    const target = chooseReverseLocateTarget({
      nodeId: canvasSelectedNodeId,
      ruleAnnotationNodeIds: annotatedRuleNodeIdsRef.current,
      reviewAnnotationNodeIds: annotatedReviewNodeIdsRef.current,
      ruleIssues: ruleCheck?.issues ?? [],
      reviews: reviewResponse?.reviews ?? [],
      screenRootId: scanResult?.rootId,
    });

    if (!target) {
      setActiveIssueId(null);
      setActiveReviewIssueId(null);
      return;
    }

    if (target.kind === "rule") {
      setActiveReviewIssueId(null);
      setActiveIssueId(target.issue.id);
      if (ruleFilter !== "all" && ruleFilter !== target.issue.ruleId) setRuleFilter("all");
      const timer = window.setTimeout(() => {
        if (ruleResultsPanelRef.current) ruleResultsPanelRef.current.open = true;
        issueCardRefs.current.get(target.issue.id)?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 0);
      return () => window.clearTimeout(timer);
    }

    setActiveIssueId(null);
    setActiveReviewIssueId(target.match.issue.id);
    const timer = window.setTimeout(() => {
      if (agentReviewPanelRef.current) agentReviewPanelRef.current.open = true;
      const reviewerCard = reviewerCardRefs.current.get(target.match.role);
      if (reviewerCard) reviewerCard.open = true;
      reviewIssueCardRefs.current.get(target.match.issue.id)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [canvasSelectionRevision]);

  function requestScan(scope: ScanScope): void {
    setStatus("正在读取节点树...");
    setScanResult(null);
    setRuleCheck(null);
    annotatedRuleNodeIdsRef.current.clear();
    annotatedReviewNodeIdsRef.current.clear();
    send({ type: "SCAN_REQUEST", scope });
  }

  async function runAgentReview(): Promise<void> {
    if (!scanResult || !ruleCheck || reviewing) return;
    setReviewing(true);
    setReviewResponse(null);
    setActiveReviewIssueId(null);
    annotatedReviewNodeIdsRef.current.clear();
    send({ type: "CLEAR_REVIEW_ANNOTATIONS", silent: true });
    setStatus("正在并行请求三位评审角色...");
    try {
      const response = await requestReview({ scan: scanResult, rules: ruleCheck, screenshotBase64: scanResult.screenshotBase64 });
      setReviewResponse(response);
      setStatus(response.incomplete ? "评审已完成，但有角色未成功返回。" : "三位评审角色已完成。 ");
    } catch (error) {
      setStatus(error instanceof Error ? `评审失败：${error.message}` : "评审失败，请检查本地代理。");
    } finally {
      setReviewing(false);
    }
  }

  function requestLocate(
    nodeId: string,
    nodeName: string,
    preserveCardSelection = false,
  ): void {
    suppressedReverseLocateNodeIdRef.current = nodeId;
    preserveForwardCardSelectionRef.current = preserveCardSelection;
    setStatus(`正在定位节点：${nodeName}...`);
    send({ type: "LOCATE_NODE", nodeId });
  }

  function requestScopeLocate(): void {
    if (!scanResult) return;
    suppressedReverseLocateNodeIdRef.current = scanResult.rootId;
    setStatus(`正在定位评估范围：${scanResult.rootName}...`);
    send({ type: "LOCATE_SCOPE", rootId: scanResult.rootId });
  }

  function toggleIssueFocus(issueId: string, nodeId: string, nodeName: string): void {
    if (activeIssueId === issueId) {
      setActiveIssueId(null);
      setStatus("正在取消节点定位...");
      send({ type: "CLEAR_NODE_FOCUS" });
      return;
    }

    setActiveIssueId(issueId);
    setActiveReviewIssueId(null);
    requestLocate(nodeId, nodeName, true);
  }

  function focusReviewIssue(issueId: string, nodeId: string, nodeName: string): void {
    setActiveIssueId(null);
    setActiveReviewIssueId(issueId);
    requestLocate(nodeId, nodeName, true);
  }

  function createAnnotations(): void {
    if (visibleIssues.length === 0) return;
    setStatus("正在创建画布标注...");
    send({ type: "CREATE_ANNOTATIONS", issues: visibleIssues });
  }

  function createReviewAnnotations(): void {
    if (reviewAnnotationIssues.length === 0) return;
    setStatus("正在创建 AI 评审问题标注...");
    send({ type: "CREATE_REVIEW_ANNOTATIONS", issues: reviewAnnotationIssues });
  }

  function downloadEvaluationReport(format: ReportFormat): void {
    if (!scanResult || !ruleCheck || !reviewResponse) return;
    const generatedAt = new Date().toISOString();
    const report = buildEvaluationReport(scanResult, ruleCheck, reviewResponse, generatedAt);
    const content = serializeReport(report, format);
    const blob = new Blob([content], {
      type: format === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = createReportFilename(scanResult.rootName, format, generatedAt);
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setStatus(`已导出 ${format === "json" ? "JSON" : "Markdown"} 评估报告。`);
  }

  return (
    <main class="app-shell">
      <header class="app-header">
        <div class="app-header-top">
          <p class="eyebrow">CRITIQUECREW</p>
          <span
            class={`connection-pill ${proxyHealth ? "is-online" : proxyError ? "is-offline" : "is-checking"}`}
            title={proxyHealth
              ? `${proxyHealth.provider} · ${proxyHealth.model} · ${proxyHealth.mockMode ? "Mock 模式" : "真实模式"}`
              : proxyError
                ? "请确认本地代理正在运行"
                : "正在连接本地代理"}
          >
            <i aria-hidden="true" />
            <b>{proxyLabel}</b>
          </span>
        </div>
        <h1>多视角 UI 评估</h1>
        <div class={`workflow-hint ${showSelectionWarning ? "is-warning" : ""}`} aria-live="polite" title={status}>
          <span>{workflowGuide.stage}</span>
          <p>{workflowGuide.message}</p>
          {showSelectionWarning && (
            <button type="button" onClick={requestScopeLocate}>
              返回 {scanTargetShortName}
            </button>
          )}
        </div>
      </header>

      <section class="scan-launch" aria-label="开始评估">
        <div class="scan-launch-copy">
          <div class="scan-launch-heading">
            <span>开始评估</span>
          </div>
          <strong>
            {selection.canScanSelection
              ? `扫描 ${selection.names[0] ?? "当前范围"}`
              : "请先选择扫描范围"}
          </strong>
        </div>
        <button
          class="primary scan-primary"
          type="button"
          disabled={!selection.canScanSelection}
          onClick={() => requestScan("selection")}
        >
          扫描选中范围
        </button>
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
        </>
      )}

      <details
        class={`agent-review panel-section ${reviewResponse ? "has-review-result" : ""}`}
        aria-label="多智能体评审"
        open={reviewing || Boolean(reviewResponse)}
        ref={agentReviewPanelRef}
      >
            <summary
              class="panel-summary"
              onClick={(event) => {
                if (!reviewResponse) event.preventDefault();
              }}
            >
              <div>
                <span class="agent-review-kicker">
                  多智能体评审
                  <small class="core-feature-badge">核心功能</small>
                </span>
                <strong>{reviewResponse ? "三位专家独立评审" : "视觉、无障碍、交互三视角"}</strong>
              </div>
              <button
                class="agent-summary-review-button"
                type="button"
                disabled={!scanResult || reviewing}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void runAgentReview();
                }}
              >
                {reviewing
                  ? "评审中..."
                  : selectionOutsideScan
                    ? `${reviewResponse ? "重评" : "评审"} ${scanTargetShortName}`
                    : reviewResponse
                      ? "重新评审"
                      : "运行 AI 评审"}
              </button>
            </summary>
            <div class="agent-review-content">
            {reviewResponse && (
              <>
                <p class="agent-review-meta">
                  {reviewResponse.mock ? "Mock 模式" : "真实模型"} · {reviewResponse.elapsedMs}ms · {reviewResponse.incomplete ? "结果不完整" : "全部角色完成"}
                </p>
                <div class="agent-score-overview" aria-label="三角色评分对比">
                  {reviewResponse.reviews.map((review) => (
                    <div class={`agent-score-tile agent-${review.role}`} key={review.role}>
                      <span>{reviewRoleShortLabels[review.role]}</span>
                      <strong>{review.status === "completed" ? review.score : "—"}</strong>
                      <small>{review.status === "completed" ? `${review.issues.length} 个问题` : "评审失败"}</small>
                    </div>
                  ))}
                </div>
                <div class="review-annotation-panel">
                  <div class="review-annotation-heading">
                    <span>画布标记</span>
                    <small>
                      共 {reviewIssueCount} 项问题，涉及 {reviewAnnotationNodeCount} 个主要节点
                    </small>
                  </div>
                  <div class="review-annotation-legend" aria-label="AI 标记优先级颜色">
                    <span class="is-high"><i aria-hidden="true" />高优先级</span>
                    <span class="is-medium"><i aria-hidden="true" />中优先级</span>
                    <span class="is-low"><i aria-hidden="true" />低优先级</span>
                  </div>
                  <div class="review-annotation-actions">
                    <button
                      class="annotation-primary"
                      type="button"
                      disabled={reviewAnnotationIssues.length === 0}
                      onClick={createReviewAnnotations}
                    >
                      标记评审问题
                    </button>
                    <button
                      class="annotation-secondary"
                      type="button"
                      onClick={() => send({ type: "CLEAR_REVIEW_ANNOTATIONS" })}
                    >
                      清除 AI 标记
                    </button>
                  </div>
                </div>
                <div class="agent-review-list">
                  {reviewResponse.reviews.map((review) => (
                    <details
                      class={`agent-card agent-${review.role}`}
                      key={review.role}
                      ref={(element) => {
                        if (element) reviewerCardRefs.current.set(review.role, element);
                        else reviewerCardRefs.current.delete(review.role);
                      }}
                    >
                      <summary>
                        <div class="agent-card-identity">
                          <span class="agent-avatar">{reviewRoleShortLabels[review.role].slice(0, 1)}</span>
                          <div>
                            <strong>{reviewRoleLabels[review.role]}</strong>
                            <small>{review.focus}</small>
                          </div>
                        </div>
                        <div class="agent-card-score">
                          <strong>{review.status === "completed" ? review.score : "—"}</strong>
                          <span>{review.status === "completed" ? "分" : "失败"}</span>
                        </div>
                      </summary>
                      <div class="agent-card-body">
                        <p class="agent-summary">{review.summary}</p>
                        {review.error && <p class="agent-error">{review.error}</p>}

                        {review.dimensions.length > 0 && (
                          <div class="agent-dimensions">
                            {review.dimensions.map((dimension) => (
                              <div class="agent-dimension" key={dimension.label}>
                                <div>
                                  <span>{dimension.label}</span>
                                  <strong>{dimension.score}</strong>
                                </div>
                                <i><b style={{ width: `${dimension.score}%` }} /></i>
                              </div>
                            ))}
                          </div>
                        )}

                        <div class="agent-issue-heading">
                          <strong>具体问题</strong>
                          <span>{review.issues.length} 项</span>
                        </div>
                        {review.issues.length > 0 ? (
                          <div class="agent-issue-list">
                            {review.issues.map((issue) => (
                              <article
                                class={`agent-issue severity-${issue.severity} ${activeReviewIssueId === issue.id ? "is-selected" : ""}`}
                                key={issue.id}
                                ref={(element) => {
                                  if (element) reviewIssueCardRefs.current.set(issue.id, element);
                                  else reviewIssueCardRefs.current.delete(issue.id);
                                }}
                              >
                                <header>
                                  <div>
                                    <span class="agent-criterion">{issue.criterion}</span>
                                    <span class={`agent-severity agent-severity-${issue.severity}`}>
                                      {reviewSeverityLabels[issue.severity]}
                                    </span>
                                  </div>
                                  <strong>{issue.title}</strong>
                                </header>
                                <dl>
                                  <div class="agent-node-row">
                                    <dt>主要节点</dt>
                                    <dd>
                                      {issue.nodeId ? (
                                        <>
                                          <span title={issue.nodeName ?? issue.nodeId}>{issue.nodeName ?? "未命名节点"}</span>
                                          <code title={issue.nodeId}>{issue.nodeId}</code>
                                          <button type="button" onClick={() => focusReviewIssue(issue.id, issue.nodeId!, issue.nodeName ?? issue.nodeId!)}>定位</button>
                                        </>
                                      ) : (
                                        <>
                                          <span>{scanResult?.rootName ?? "当前评估范围"}</span>
                                          <code>屏幕级问题</code>
                                          <button type="button" onClick={requestScopeLocate}>定位范围</button>
                                        </>
                                      )}
                                    </dd>
                                  </div>
                                  {issue.relatedNodes.length > 0 && (
                                    <div class="agent-related-row">
                                      <dt>关联节点</dt>
                                      <dd>
                                        {issue.relatedNodes.map((relatedNode) => (
                                          <button
                                            type="button"
                                            key={relatedNode.nodeId}
                                            title={`${relatedNode.nodeName} · ${relatedNode.nodeId}`}
                                            onClick={() => requestLocate(relatedNode.nodeId, relatedNode.nodeName)}
                                          >
                                            {relatedNode.nodeName}
                                          </button>
                                        ))}
                                      </dd>
                                    </div>
                                  )}
                                  <div class="agent-primary-copy">
                                    <dt>问题描述</dt>
                                    <dd>{issue.explanation}</dd>
                                  </div>
                                  <div class="agent-primary-copy">
                                    <dt>修改建议</dt>
                                    <dd>{issue.suggestion}</dd>
                                  </div>
                                  <div class="agent-support-row">
                                    <dt>证据依据</dt>
                                    <dd>
                                      <details>
                                        <summary>
                                          {issue.basisIds.length > 0
                                            ? `查看证据与相关参考（${issue.basisIds.length} 项）`
                                            : "查看评审证据（AI 专业判断）"}
                                        </summary>
                                        <div class="agent-support-content">
                                          <p><strong>评审证据</strong>{issue.evidence}</p>
                                          <p class="agent-basis-note">
                                            该问题由 AI 结合截图、节点数据和专业知识判断；相关参考不是唯一评审来源，也不等同于合规认证。
                                          </p>
                                          {issue.basisIds.length > 0 && (
                                            <div class="agent-basis-links">
                                              <strong>相关参考</strong>
                                              {issue.basisIds.map((basisId) => {
                                                const basis = getReviewBasis(basisId);
                                                return (
                                                  <a
                                                    href={basis.url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    title={`${basis.publisher} · ${basis.summary}`}
                                                    key={basis.id}
                                                  >
                                                    <span>{basis.kind === "standard" ? "标准" : basis.kind === "guideline" ? "指南" : "启发式"}</span>
                                                    {basis.id}
                                                  </a>
                                                );
                                              })}
                                            </div>
                                          )}
                                        </div>
                                      </details>
                                    </dd>
                                  </div>
                                </dl>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <p class="agent-empty">该视角未发现需要优先处理的问题。</p>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              </>
            )}
            </div>
      </details>

      {reviewResponse && (
        <details class={`coordination-panel panel-section coordination-${reviewResponse.coordination.status}`} aria-label="评审协调者总体评价">
          <summary class="coordination-heading">
            <div>
              <span>评审协调者</span>
              <strong>总体评价</strong>
            </div>
            <div class="composite-score">
              <small>专家综合分</small>
              <strong>{reviewResponse.compositeScore.score ?? "—"}</strong>
            </div>
          </summary>
          <div class="coordination-overview">
            {reviewResponse.coordination.perspectives.length > 0 && (
              <ul class="coordination-perspectives">
                {reviewResponse.coordination.perspectives.map((perspective) => (
                  <li class={`perspective-${perspective.role}`} key={perspective.role}>
                    <strong>{coordinationPerspectiveLabels[perspective.role]}</strong>
                    <span>{perspective.summary}</span>
                  </li>
                ))}
              </ul>
            )}
            <p class="coordination-conclusion">{reviewResponse.coordination.overallSummary}</p>
          </div>
          <div class="relationship-counts">
            <span><b>{reviewResponse.coordination.consensus.length}</b> 项共识</span>
            <span><b>{reviewResponse.coordination.differences.length}</b> 项判断差异</span>
            <span class={reviewResponse.coordination.conflicts.length > 0 ? "has-conflict" : ""}>
              <b>{reviewResponse.coordination.conflicts.length}</b> 项方向分歧
            </span>
          </div>
          {reviewResponse.coordination.error && (
            <p class="agent-error">综合错误：{reviewResponse.coordination.error}</p>
          )}
          {reviewResponse.coordination.consensus.map((consensus) => (
            <details class="relationship-card consensus-card" key={`consensus:${consensus.id}`}>
              <summary>
                <span>共识</span>
                <strong>{consensus.nodeName} · {reviewAspectLabels[consensus.aspect]}</strong>
              </summary>
              <button
                type="button"
                class="relationship-locate"
                onClick={() => requestLocate(
                  consensus.nodeId,
                  consensus.nodeName,
                )}
              >
                定位共识节点
              </button>
              <div class="relationship-opinions">
                {consensus.issues.map((issue) => (
                  <article key={`${consensus.id}:${issue.issueId}`}>
                    <header>
                      <b>{reviewRoleLabels[issue.role]}</b>
                      <em>{reviewDirectionLabels[issue.direction]}</em>
                    </header>
                    <strong>{issue.title}</strong>
                    <p>{issue.suggestion}</p>
                  </article>
                ))}
              </div>
            </details>
          ))}
          {reviewResponse.coordination.differences.map((difference) => (
            <details class="relationship-card difference-card" key={`difference:${difference.id}`}>
              <summary>
                <span>判断差异</span>
                <strong>{difference.nodeName} · {reviewAspectLabels[difference.aspect]}</strong>
              </summary>
              <p>{difference.reason}</p>
              <button
                type="button"
                class="relationship-locate"
                onClick={() => requestLocate(
                  difference.nodeId,
                  difference.nodeName,
                )}
              >
                定位判断差异节点
              </button>
              <div class="relationship-opinions">
                {difference.issues.map((issue) => (
                  <article key={`${difference.id}:${issue.issueId}`}>
                    <header>
                      <b>{reviewRoleLabels[issue.role]}</b>
                      <em>{reviewSeverityLabels[issue.severity]}</em>
                    </header>
                    <strong>{issue.title}</strong>
                    <p>{issue.suggestion}</p>
                  </article>
                ))}
              </div>
            </details>
          ))}
          {reviewResponse.coordination.conflicts.map((conflict) => {
            const tradeoff = reviewResponse.coordination.tradeoffs.find((item) => item.conflictId === conflict.id);
            return (
              <details class="relationship-card conflict-card" key={`conflict:${conflict.id}`} open>
                <summary>
                  <span>方向分歧</span>
                  <strong>{tradeoff?.topic ?? `${conflict.nodeName} · ${reviewAspectLabels[conflict.aspect]}`}</strong>
                </summary>
                <button
                  type="button"
                  class="relationship-locate"
                  onClick={() => requestLocate(
                    conflict.nodeId,
                    conflict.nodeName,
                  )}
                >
                  定位分歧节点
                </button>
                <div class="relationship-opinions">
                  {conflict.issues.map((issue) => (
                    <article key={`${conflict.id}:${issue.issueId}`}>
                      <header>
                        <b>{reviewRoleLabels[issue.role]}</b>
                        <em>{reviewDirectionLabels[issue.direction]}</em>
                      </header>
                      <strong>{issue.title}</strong>
                      <p>{issue.suggestion}</p>
                    </article>
                  ))}
                </div>
                {tradeoff && (
                  <div class="tradeoff-guidance">
                    <span>核心权衡</span>
                    <p>{tradeoff.tradeoffSummary}</p>
                    <span>协调建议</span>
                    <strong>{tradeoff.coordinatedSuggestion}</strong>
                    {tradeoff.unresolvedNote && (
                      <small>保留分歧：{tradeoff.unresolvedNote}</small>
                    )}
                  </div>
                )}
              </details>
            );
          })}
        </details>
      )}

      {scanResult && (
        <>
          {ruleCheck && (
            <details
              class="rule-results panel-section"
              aria-label="自动化规则检测结果"
              ref={ruleResultsPanelRef}
            >
              <summary class="rule-results-summary panel-summary">
                <div>
                  <span>自动化规则检测</span>
                  <strong>{ruleCheck.issues.length} 项待修复</strong>
                </div>
                <aside class="rule-check-scope">
                  <span>自动检查</span>
                  <b>颜色对比度 · 字号 · 点击区域</b>
                </aside>
              </summary>

              <div class="rule-results-content">

              {ruleCheck.issues.length > 0 && (
                <div class="rule-filter-bar" aria-label="按规则类型筛选">
                  <span>筛选</span>
                  <div class="rule-filter-options">
                    {ruleFilters.map((filter) => (
                      <button
                        class={`rule-filter ${ruleFilter === filter.id ? "is-active" : ""}`}
                        type="button"
                        key={filter.id}
                        aria-pressed={ruleFilter === filter.id}
                        onClick={() => setRuleFilter(filter.id)}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                  <small>显示 {visibleIssues.length} / {ruleCheck.issues.length} 项</small>
                </div>
              )}

              {ruleCheck.issues.length > 0 && (
                <div class="annotation-actions">
                  <button class="annotation-primary" type="button" disabled={visibleIssues.length === 0} onClick={createAnnotations}>
                    标注当前筛选项
                  </button>
                  <button class="annotation-secondary" type="button" onClick={() => send({ type: "CLEAR_ANNOTATIONS" })}>
                    清除标注
                  </button>
                </div>
              )}

              {visibleIssues.length > 0 ? (
                <div class="rule-issue-list">
                  {visibleIssues.map((issue) => (
                    <article
                      class={`rule-issue ${activeIssueId === issue.id ? "is-selected" : ""}`}
                      key={issue.id}
                      ref={(element) => {
                        if (element) issueCardRefs.current.set(issue.id, element);
                        else issueCardRefs.current.delete(issue.id);
                      }}
                      role="button"
                      tabIndex={0}
                      aria-pressed={activeIssueId === issue.id}
                      aria-label={`在画布中定位：${issue.nodeName}`}
                      onClick={() => toggleIssueFocus(issue.id, issue.nodeId, issue.nodeName)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggleIssueFocus(issue.id, issue.nodeId, issue.nodeName);
                        }
                      }}
                    >
                      <div class="rule-issue-title">
                        <span class={`severity severity-${issue.severity}`}>
                          {issue.severity === "warning" ? "建议优化" : "需修复"}
                        </span>
                        <strong>{issue.message}</strong>
                      </div>
                      <dl>
                        <div>
                          <dt>节点</dt>
                          <dd title={issue.nodeName}>{issue.nodeName}</dd>
                        </div>
                        <div>
                          <dt>节点 ID</dt>
                          <dd><code title={issue.nodeId}>{issue.nodeId}</code></dd>
                        </div>
                        <div>
                          <dt>检测值</dt>
                          <dd>{issue.actual}</dd>
                        </div>
                        <div>
                          <dt>要求</dt>
                          <dd>{issue.expected}</dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              ) : (
                <p class="rule-success">
                  {ruleCheck.issues.length === 0 ? "当前扫描范围内未发现规则违规项。" : "当前筛选条件下没有问题项。"}
                </p>
              )}

              {ruleCheck.skippedContrastNodes > 0 && (
                <p class="rule-note">
                  {ruleCheck.skippedContrastNodes} 个文本节点缺少可确定的纯色背景，暂未计算其对比度。
                </p>
              )}
              </div>
            </details>
          )}
        </>
      )}

      {scanResult && ruleCheck && reviewResponse && (
        <section class="report-export panel-section" aria-label="导出评估报告">
          <div class="report-export-copy">
            <span>报告导出</span>
            <strong>完整评估结果</strong>
            <small>
              包含规则检测结果、专家视角评分与结论、具体问题、节点定位信息、修复建议及总体评价
            </small>
          </div>
          <div class="report-export-actions">
            <button
              class="report-export-button"
              type="button"
              onClick={() => downloadEvaluationReport("markdown")}
            >
              导出 Markdown
            </button>
            <button
              class="report-export-button"
              type="button"
              onClick={() => downloadEvaluationReport("json")}
            >
              导出 JSON
            </button>
          </div>
        </section>
      )}

    </main>
  );
}
