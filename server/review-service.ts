import { z } from "zod";
import { BailianClient, type ChatMessage } from "./bailian-client";
import type { ServerConfig } from "./config";
import {
  REVIEW_ASPECTS,
  REVIEW_DIRECTIONS,
  REVIEWER_ROLES,
  type AgentReview,
  type ReviewRequest,
  type ReviewResponse,
  type ReviewerRole,
} from "../src/shared/review";
import {
  getReviewBasesForRole,
  REVIEW_BASIS_IDS,
  type ReviewBasisId,
} from "../src/shared/review-basis";
import { analyzeReviewRelationships, calculateCompositeScore } from "../src/shared/arbitration";
import { coordinateReviews } from "./coordination-service";

const MAX_ROLE_ISSUES = 5;

const dimensionSchema = z.object({
  label: z.string().min(1).max(40),
  score: z.number().min(0).max(100),
  observation: z.string().min(1).max(180),
});

const issueSchema = z.object({
  primaryNodeId: z.string().min(1).nullable().optional(),
  relatedNodeIds: z.array(z.string().min(1)).max(20).default([]),
  severity: z.enum(["high", "medium", "low"]),
  criterion: z.string().min(1).max(60),
  aspect: z.enum(REVIEW_ASPECTS).default("other"),
  direction: z.enum(REVIEW_DIRECTIONS).default("unspecified"),
  title: z.string().min(1).max(60),
  evidence: z.string().min(1).max(220),
  basisIds: z.array(z.enum(REVIEW_BASIS_IDS)).max(3).default([]),
  explanation: z.string().min(1).max(220),
  suggestion: z.string().min(1).max(220),
});

const modelReviewSchema = z.object({
  score: z.number().min(0).max(100),
  dimensions: z.array(dimensionSchema).min(3).max(5),
  summary: z.string().min(1).max(320),
  issues: z.array(issueSchema).max(20),
});

type RoleDesign = {
  label: string;
  focus: string;
  dimensions: readonly string[];
  systemPrompt: string;
};

const PAGE_SEMANTICS_REVIEW_PROTOCOL = `
【共同评审前提】
在进入你的专业维度前，必须先根据截图、根节点名称、页面标题、可见文案、节点命名和重复结构理解页面语义：
1. 识别页面所处场景、主要用户、当前阶段和最可能的核心任务；不要把页面当作无业务含义的图形集合。
2. 找出页面的核心业务对象、重复单元和关键操作，并根据当前页面实际出现的内容归纳其中的信息角色；不要预设某个行业固定包含哪些字段。
3. 按用户完成任务时的扫视顺序检查信息架构：用户首先要确认什么、随后比较什么、最后执行什么；判断视觉顺序、空间分组和语义关系是否支持这一过程。
4. 当页面语义可以由标题、文案、组件结构等多个明确线索共同支持时，应按推断出的场景主动检查核心对象是否清楚、信息是否便于理解和比较、关键操作是否符合任务顺序，而不只检查字体和间距。
5. 严格区分三类判断：截图或节点可确认的事实、由多个页面线索支持的高可信语义推断、依赖未提供产品需求的假设。前两类可以形成问题；第三类只能写成有条件的优化建议，不得把个人偏好写成确定缺陷。
6. 不要预设某一种固定版式、内容字段或组件形态是唯一答案。只有输入能够证明某项内容是任务必需时，才能把它的缺失判为确定问题；否则应围绕当前结构造成的实际影响给出有条件的优化建议。
`.trim();

export const ROLE_DESIGNS: Record<ReviewerRole, RoleDesign> = {
  visual: {
    label: "视觉设计师",
    focus: "层级、留白、一致性、视觉节奏",
    dimensions: ["信息层级", "布局留白", "一致性", "视觉节奏"],
    systemPrompt: `
【角色设定】
你是 CritiqueCrew 的资深视觉设计师。你必须独立评审设计，不要充当 WCAG 规则检查器。

${PAGE_SEMANTICS_REVIEW_PROTOCOL}

【评审维度】
只从视觉设计专业角度判断：
1. 信息层级：用户打开页面后，能否很快看出页面主题、最重要的信息和下一步操作；标题、关键数据、主要按钮是否比次要说明更容易被看到。
2. 布局留白：先检查内容在整个容器中的上下分布是否均衡，包括首个内容到顶部、最后一个内容到底部的边缘空白；再检查相关内容是否靠得较近、无关内容之间是否有足够间隔。文字、卡片和按钮之间是否过于拥挤，或松散到难以判断它们是否属于同一组。
3. 一致性：相同用途的按钮、标题、标签和卡片是否使用相近样式；相同颜色或图标是否表达相近含义，避免用户在不同区域重新猜测。
4. 视觉节奏：页面从上到下阅读是否顺畅；重复的卡片、列表项和数据项是否整齐；是否同时出现太多醒目的颜色、大字号或粗体，导致用户不知道先看什么。

【评审边界】
禁止逐条复述字号、对比度、44px 等自动化规则结果。只有当它们造成明显视觉层级或节奏问题时，才可从视觉角度合并为一个问题。
布局留白和视觉节奏属于设计质量判断，不得表述为 WCAG 不合规；只有 allowedReviewBases 中 kind 为 standard 且静态证据足够时，才能声称未满足相应标准。
必须先判断页面整体内容分布和容器边缘空白，再判断局部节点间距。某个相邻间距数值较大不等于存在问题；只有它明显偏离同组常用间距，并且截图中确实破坏分组或阅读连续性时，才能报告局部间距问题。containerEdgeWhitespace 用于判断容器顶部和底部空白，largestSiblingGaps 用于比较相邻节点间距及其相对常用间距的倍数。

【输出要求】
每个问题依次说明页面证据、造成的视觉影响和可执行的改进建议。
最多给出 5 个最重要、彼此不重复的问题；同类节点必须合并，不要逐节点列举。
评分维度固定为：信息层级、布局留白、一致性、视觉节奏。
`.trim(),
  },
  accessibility: {
    label: "无障碍专家",
    focus: "理解、信息关系、说明纠错、可预期性、包容性",
    dimensions: ["可理解性", "信息关系", "说明与纠错", "可预期性", "包容性"],
    systemPrompt: `
【角色设定】
你是 CritiqueCrew 的无障碍与可访问性专家。你需要独立判断，不是自动化规则的复读器。

${PAGE_SEMANTICS_REVIEW_PROTOCOL}

【评审维度】
从语义理解与包容性角度评审：
1. 可理解性：标题、按钮文字、提示语和数据说明是否表达清楚；是否存在只有内部人员才懂的缩写、专业词语或含糊说法；没有文字的图标是否容易理解；用户是否需要反复猜测内容含义。
2. 信息关系：用户能否看出标题对应哪部分内容；提示文字是否靠近它所说明的输入项或操作；相关信息是否放在一起；页面的可见阅读顺序是否符合内容含义。
3. 说明与纠错：输入框、选择项和提交操作前是否说明需要填写或选择什么；是否说明必填项、格式和限制；发生错误后能否看出哪里错了、应该怎样修改。
4. 可预期性：相同内容或操作是否使用相同名称；相同图标是否始终表示相近含义；用户选择或填写某项后，是否可能发生没有提前说明的变化；不同区域的表达方式是否稳定。
5. 包容性：检查设计是否会增加不同用户理解和使用页面的难度。重要信息是否因文字过小、过细、过浅或页面过密而不利于低视力用户阅读；状态和数据是否只用颜色区分，使有色觉差异的用户难以理解；页面是否一次呈现过多信息或选择，是否要求用户记住前文，是否使用大量未解释的缩写、数字和专业词语，从而增加认知负担；在强光、屏幕亮度较低、疲劳、压力或注意力受干扰等情境下，关键信息是否仍然容易发现和理解。只有页面存在具体证据时才能报告相关风险，不要凭空假设用户情境。

【评审边界】
自动化规则仅作为证据线索，不得逐条照抄。相同原因的字号或对比度问题必须合并，并说明它对用户完成任务的真实影响。
对比度数值由自动化规则负责，不要在包容性中重复报告同一个数值问题。
静态设计只能确认可见的分组、顺序和文案；代码语义、读屏顺序、辅助技术名称和真实交互行为只能标注为“需要在实现中验证”。
W3C COGA、Apple 和 Microsoft 的 guideline 只能支持无障碍风险或设计建议，不得表述为违反 WCAG。

【输出要求】
每个问题依次说明页面证据、对相关用户理解或完成任务的影响，以及可执行的改进建议。
至少优先寻找一项自动规则无法覆盖的语义层问题；最多给出 5 个最重要、彼此不重复的问题。
评分维度固定为：可理解性、信息关系、说明与纠错、可预期性、包容性。
`.trim(),
  },
  interaction: {
    label: "交互设计师",
    focus: "操作路径合理性、反馈明确性、误操作风险",
    dimensions: ["操作路径合理性", "反馈明确性", "误操作风险"],
    systemPrompt: `
【角色设定】
你是 CritiqueCrew 的资深交互设计师。你必须独立评审用户如何理解并完成任务。

${PAGE_SEMANTICS_REVIEW_PROTOCOL}

【评审维度】
只从交互设计角度判断：
1. 操作路径合理性：先判断用户在当前场景中是查看、比较、选择还是管理，再检查用户是否容易找到完成任务的入口；按钮、链接、输入框旁的文字或图标是否说明用途；多步骤任务是否按照用户完成任务的自然顺序组织。
2. 反馈明确性：用户点击、提交或切换后，是否能看出系统正在处理、已经成功、失败，或者下一步应该做什么；提示是否靠近相关内容且不容易被忽略。可选、已选、禁用、进行中和完成等状态在本维度内检查，不再单独评分。
3. 误操作风险：删除、退出、提交等重要操作是否容易被误触；后果较大的操作是否有明确提示、确认机会、撤销方式或修改机会；错误发生后是否容易恢复。

【评审边界】
不要报告纯粹的字号、颜色对比度或静态排版问题，除非它直接导致操作入口不可发现或状态不可辨。
可以提出画面中缺失但任务需要的状态设计；如果缺失状态属于某个现有卡片、按钮、输入框或标签，primaryNodeId 必须定位到该组件。只有问题确实影响整个页面、且不存在任何可作为修改入口的具体节点时，primaryNodeId 才可使用 null。
WCAG 3.3.4 只适用于法律承诺、金融交易、数据修改和考试作答等规定场景；普通操作的误操作风险只能依据 guideline 或 heuristic 表述为设计建议。

【输出要求】
每个问题依次说明页面证据、对任务完成的影响和可执行的改进建议。
最多给出 5 个最重要、彼此不重复的问题。
评分维度固定为：操作路径合理性、反馈明确性、误操作风险。
`.trim(),
  },
};

function mockReview(role: ReviewerRole, request: ReviewRequest, latencyMs: number): AgentReview {
  const roleDesign = ROLE_DESIGNS[role];
  const firstRuleIssue = request.rules.issues[0];
  const firstNode = request.scan.nodes.find((node) => node.type === "TEXT") ?? request.scan.nodes[0];
  const conflictNode = request.scan.nodes.find((node) => node.hasPointerInteraction) ?? firstNode;
  const conflictNodeInfo = conflictNode
    ? { nodeId: conflictNode.id, nodeName: conflictNode.name, relatedNodes: [] }
    : { nodeId: null, nodeName: null, relatedNodes: [] };
  const copies: Record<ReviewerRole, Pick<AgentReview, "score" | "dimensions" | "summary" | "issues">> = {
    visual: {
      score: 78,
      dimensions: [
        { label: "信息层级", score: 76, observation: "主要内容可识别，但关键操作的强调仍然不足。" },
        { label: "布局留白", score: 72, observation: "局部区域的垂直间距不均，页面节奏出现断层。" },
        { label: "一致性", score: 84, observation: "基础样式较统一，少数组件仍存在视觉差异。" },
        { label: "视觉节奏", score: 80, observation: "内容密度前紧后松，阅读路径不够连续。" },
      ],
      summary: "主次关系基本成立，但关键操作与辅助信息之间的视觉差异仍可加强。",
      issues: conflictNode ? [{
        id: "visual-1", ...conflictNodeInfo, severity: "medium", criterion: "信息层级",
        aspect: "visual-prominence", direction: "weaken",
        title: "次要操作入口的视觉权重过强",
        evidence: "该操作入口与页面主要内容形成竞争，削弱了主任务的信息层级。",
        basisIds: ["APPLE-DESIGN-TIPS"],
        explanation: "次要入口过度突出会分散用户注意力，使页面主任务不够集中。",
        suggestion: "降低该入口的颜色强度或视觉重量，让主内容获得更明确的优先级。",
      }] : [],
    },
    accessibility: {
      score: firstRuleIssue ? 66 : 84,
      dimensions: [
        { label: "可理解性", score: 78, observation: "多数标签清楚，但状态说明还可更明确。" },
        { label: "信息关系", score: 76, observation: "主要分组可以识别，局部提示与对应内容的关系仍可加强。" },
        { label: "说明与纠错", score: 74, observation: "基础说明可见，但错误后的修改方式还不够明确。" },
        { label: "可预期性", score: 80, observation: "多数名称和表达保持一致，少数状态变化仍需补充说明。" },
        { label: "包容性", score: 70, observation: "部分状态较依赖颜色与视觉差异。" },
      ],
      summary: firstRuleIssue ? "存在会影响低视力用户获取信息的风险，建议优先处理。" : "基础可读性尚可，仍需检查状态是否只依赖颜色表达。",
      issues: firstRuleIssue ? [{
        id: "accessibility-1",
        nodeId: firstRuleIssue.nodeId,
        nodeName: firstRuleIssue.nodeName,
        relatedNodes: [],
        severity: "high",
        criterion: "包容性",
        aspect: "readability",
        direction: "strengthen",
        title: "关键信息对低视力用户不够友好",
        evidence: `自动检测在节点 ${firstRuleIssue.nodeName} 上发现 ${firstRuleIssue.actual}，低于当前项目的预期 ${firstRuleIssue.expected}。`,
        basisIds: firstRuleIssue.ruleId === "color-contrast"
          ? ["WCAG22-1.4.3"]
          : firstRuleIssue.ruleId === "target-size"
            ? ["APPLE-HIT-TARGET-44", "WCAG22-2.5.8"]
            : ["APPLE-DESIGN-TIPS"],
        explanation: `自动检测显示 ${firstRuleIssue.actual}，这会增加识别关键信息的负担。`,
        suggestion: `调整到 ${firstRuleIssue.expected}，并检查相同用途的节点是否采用一致方案。`,
      }] : [],
    },
    interaction: {
      score: 74,
      dimensions: [
        { label: "操作路径合理性", score: 78, observation: "主任务入口较清楚，但下一步行动仍可强化。" },
        { label: "反馈明确性", score: 64, observation: "关键操作缺少进行中、成功和失败反馈。" },
        { label: "误操作风险", score: 82, observation: "未见明显危险操作，但恢复路径信息有限。" },
      ],
      summary: "主要操作入口可以识别，但关键操作后的状态反馈不够完整。",
      issues: conflictNode ? [{
        id: "interaction-1", ...conflictNodeInfo, severity: "high", criterion: "操作路径合理性",
        aspect: "visual-prominence", direction: "strengthen",
        title: "关键操作入口不够醒目",
        evidence: "该入口承担主要操作路径，但当前视觉呈现不足以让用户快速发现下一步行动。",
        basisIds: ["APPLE-DESIGN-PRINCIPLES"],
        explanation: "入口不够醒目会降低任务可发现性，用户可能无法确认下一步操作。",
        suggestion: "增强该入口的颜色对比或视觉重量，使其在当前任务路径中更容易被发现。",
      }] : [],
    },
  };
  return {
    role,
    focus: roleDesign.focus,
    ...copies[role],
    status: "completed",
    latencyMs,
    error: null,
  };
}

function compactNodeData(request: ReviewRequest) {
  return request.scan.nodes.slice(0, 600).map((node) => ({
    id: node.id,
    parentId: node.parentId,
    name: node.name,
    type: node.type,
    depth: node.depth,
    x: node.x,
    y: node.y,
    absoluteX: node.absoluteX,
    absoluteY: node.absoluteY,
    width: node.width,
    height: node.height,
    fontSize: node.fontSize,
    characters: node.characters,
    fillKind: node.fillKind,
    fills: node.fills,
    opacity: node.opacity,
    hasPointerInteraction: node.hasPointerInteraction,
  }));
}

const INPUT_EVIDENCE_POLICY = {
  renderedAppearance: "Use the screenshot as the primary evidence for rendered color, fill, and visual emphasis, and use node fills and opacity as supporting evidence.",
  geometryAndHierarchy: "Use node dimensions, absolute positions, parent relationships, and depth as the authoritative evidence for geometry and hierarchy.",
  insufficientOrConflictingEvidence: "If the screenshot and node data conflict, or neither provides enough evidence, do not state a definite issue; identify it as requiring verification.",
} as const;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function siblingGapEvidence(request: ReviewRequest) {
  const groups = new Map<string, typeof request.scan.nodes>();
  for (const node of request.scan.nodes) {
    if (node.absoluteY === null) continue;
    const parentKey = node.parentId ?? "__root__";
    const siblings = groups.get(parentKey) ?? [];
    siblings.push(node);
    groups.set(parentKey, siblings);
  }

  return [...groups.values()]
    .flatMap((siblings) => {
      const ordered = [...siblings].sort((left, right) => (left.absoluteY ?? 0) - (right.absoluteY ?? 0));
      const gaps = ordered.slice(0, -1).map((node, index) => {
        const next = ordered[index + 1];
        const gap = (next.absoluteY ?? 0) - ((node.absoluteY ?? 0) + node.height);
        return {
          parentId: node.parentId,
          from: { id: node.id, name: node.name },
          to: { id: next.id, name: next.name },
          verticalGap: Math.round(gap * 100) / 100,
        };
      });
      const positiveGaps = gaps.map((item) => item.verticalGap).filter((gap) => gap >= 0);
      const typicalGap = positiveGaps.length >= 2 ? median(positiveGaps) : null;
      return gaps.map((item) => ({
        ...item,
        typicalSiblingGap: typicalGap === null ? null : Math.round(typicalGap * 100) / 100,
        multipleOfTypical: typicalGap && typicalGap > 0
          ? Math.round((item.verticalGap / typicalGap) * 100) / 100
          : null,
      }));
    })
    .filter((item) => item.verticalGap >= 16)
    .sort((left, right) => right.verticalGap - left.verticalGap)
    .slice(0, 12);
}

function containerEdgeWhitespaceEvidence(request: ReviewRequest) {
  const nodesById = new Map(request.scan.nodes.map((node) => [node.id, node]));

  function isDescendantOf(nodeId: string, containerId: string): boolean {
    let parentId = nodesById.get(nodeId)?.parentId ?? null;
    while (parentId) {
      if (parentId === containerId) return true;
      parentId = nodesById.get(parentId)?.parentId ?? null;
    }
    return false;
  }

  return request.scan.nodes
    .filter((container) =>
      container.childIds.length > 0
      && container.absoluteY !== null
      && container.height > 0,
    )
    .map((container) => {
      const containerTop = container.absoluteY!;
      const containerBottom = containerTop + container.height;
      const contentNodes = request.scan.nodes.filter((node) => {
        if (
          node.id === container.id
          || node.absoluteY === null
          || !isDescendantOf(node.id, container.id)
        ) return false;
        const nodeBottom = node.absoluteY + node.height;
        const contained = node.absoluteY >= containerTop - 1 && nodeBottom <= containerBottom + 1;
        const coversContainer = node.width >= container.width * 0.9 && node.height >= container.height * 0.9;
        return contained && !coversContainer;
      });
      if (contentNodes.length === 0) return null;

      const first = [...contentNodes].sort((left, right) =>
        (left.absoluteY! - right.absoluteY!) || (left.depth - right.depth),
      )[0];
      const last = [...contentNodes].sort((left, right) => {
        const bottomDifference = (right.absoluteY! + right.height) - (left.absoluteY! + left.height);
        return bottomDifference || (left.depth - right.depth);
      })[0];
      const topGap = Math.max(0, first.absoluteY! - containerTop);
      const bottomGap = Math.max(0, containerBottom - (last.absoluteY! + last.height));
      return {
        container: { id: container.id, name: container.name },
        firstContent: { id: first.id, name: first.name },
        lastContent: { id: last.id, name: last.name },
        topGap: Math.round(topGap * 100) / 100,
        bottomGap: Math.round(bottomGap * 100) / 100,
        bottomGapRatio: Math.round((bottomGap / container.height) * 1000) / 1000,
        edgeImbalance: Math.round(Math.abs(bottomGap - topGap) * 100) / 100,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .filter((item) => Math.max(item.topGap, item.bottomGap) >= 16)
    .sort((left, right) =>
      Math.max(right.topGap, right.bottomGap) + right.edgeImbalance
      - Math.max(left.topGap, left.bottomGap) - left.edgeImbalance,
    )
    .slice(0, 12);
}

function roleContext(role: ReviewerRole, request: ReviewRequest) {
  const ruleSummary = {
    issueCount: request.rules.issues.length,
  };
  return role === "accessibility"
    ? { ruleSummary, automatedRuleSignals: request.rules.issues.slice(0, 12) }
    : { automatedRules: "omitted to preserve an independent professional review" };
}

function basisContext(role: ReviewerRole) {
  return getReviewBasesForRole(role).map((basis) => ({
    id: basis.id,
    title: basis.title,
    publisher: basis.publisher,
    kind: basis.kind,
    summary: basis.summary,
  }));
}

export function buildReviewMessages(role: ReviewerRole, request: ReviewRequest): ChatMessage[] {
  const design = ROLE_DESIGNS[role];
  const scope = {
    scope: request.scan.scope,
    rootId: request.scan.rootId,
    rootName: request.scan.rootName,
    rootType: request.scan.rootType,
    nodeCount: request.scan.nodeCount,
    truncated: request.scan.truncated,
  };
  const payload = JSON.stringify({
    scope,
    evidencePolicy: INPUT_EVIDENCE_POLICY,
    roleContext: roleContext(role, request),
    allowedReviewBases: basisContext(role),
    ...(role === "visual" ? {
      layoutEvidence: {
        largestSiblingGaps: siblingGapEvidence(request),
        containerEdgeWhitespace: containerEdgeWhitespaceEvidence(request),
      },
    } : {}),
    nodes: compactNodeData(request),
  });
  const outputContract = `
只输出合法 JSON：
{
  "score": 0-100,
  "dimensions": [{"label":"指定维度名称","score":0-100,"observation":"该维度的具体观察"}],
  "summary": "不超过80字的总体判断",
  "issues": [{
    "primaryNodeId": "主要定位节点；必须来自输入节点，纯屏幕级问题可为null",
    "relatedNodeIds": ["最多3个关联节点ID，必须来自输入节点"],
    "severity": "high|medium|low",
    "criterion": "所属专业维度",
    "aspect": "visual-prominence|information-density|readability|interaction-entry|status-feedback|error-prevention|other",
    "direction": "strengthen|weaken|add|remove|retain|restructure|unspecified",
    "title": "15至30字：直接写明具体对象和可观察的问题，让用户一眼看懂哪里需要修改",
    "evidence": "30至60字：从截图或节点数据观察到的具体事实，不得把推测写成事实",
    "basisIds": ["仅在来源与问题直接相关时，从 allowedReviewBases 选择 1 至 3 个编号；没有直接对应来源时必须返回空数组"],
    "explanation": "35至70字：直接说明问题及其主要影响，不重复标题、证据或标准原文",
    "suggestion": "35至70字：只给1至2个最关键、可执行的修改动作"
  }]
}
不要输出 Markdown，不要虚构节点 ID，不要重复同类问题，也不要编造标准、出处或依据编号。
aspect 表示问题实际涉及的设计属性；direction 表示建议对该属性采取的动作。无法归类时使用 other 或 unspecified，不得为了制造冲突而强行选择方向。
每个问题必须给出可从输入中核对的 evidence。basisIds 是相关参考而非唯一评审来源：只有来源内容能够直接支持该问题时才引用；不得为了让问题显得权威而强行匹配来源，没有直接对应来源时返回空数组。
文字必须短而明确：先说结论，删除背景铺垫、重复解释和泛泛建议；evidence、explanation、suggestion 均不得超过两句话。
问题标题必须使用“具体对象 + 具体问题”的直白表达，不写比喻、感受或只有设计师才懂的抽象判断。不得使用“缺乏呼吸感”“视觉节奏失衡”“层次感不足”“视觉噪音”等笼统词语；应分别改写为“间距太小或太大”“排列或间距不一致”“主次区分不明显”“干扰注意力的元素过多”等可观察的问题。例如不要写“按钮缺乏呼吸感”，要写“按钮与上方提示区域距离太近”。
所有面向用户展示的文字都要让没有设计专业背景的人直接看懂。优先描述元素实际呈现方式和用户可能遇到的情况，不要直接使用“幽灵按钮”“可供性”“视觉锚点”“认知摩擦”等未解释的行业术语；例如把“幽灵按钮”写成“只有文字或细边框、背景不明显的次要按钮”。标准名称或必要术语无法避免时，首次出现必须紧接一句通俗解释。
所有面向用户的 title、dimensions.observation、summary、evidence、explanation 和 suggestion 必须使用中文。除 px、pt、rem、ms、s 等计量单位外，不得在中文句子中穿插英文单词或英文缩写。将 padding 写成“内边距”、margin 写成“外边距”、loading 写成“加载状态”、toast 写成“轻提示”；标准名称在正文中使用中文概括，原始编号只放在 basisIds；节点 ID 和输入中的原始节点名称只放在对应结构化字段，不要为了引用它们而在自然语言中重复英文。
只有 kind 为 standard 的依据可以表述为“未满足该标准”，且必须有足够的静态证据；kind 为 guideline 或 heuristic 时，只能表述为“设计建议”或“潜在风险”，不得宣称不合规。
涉及两个或多个节点的间距、对齐、层级或流程问题：primaryNodeId 必须选择用户最需要先修改的具体节点，relatedNodeIds 填写其他关联节点。对于垂直间距问题，优先使用 layoutEvidence 中 from 节点作为 primaryNodeId、to 节点作为关联节点；不要为了表示节点关系而选择整个页面共同父容器。
只要问题标题或说明指向某个具体卡片、控件、标签或区域，primaryNodeId 就不得为 null。relatedNodeIds 非空时也必须提供 primaryNodeId。null 仅用于真正无法归属于任何现有节点的全屏结构或全局流程问题。`.trim();
  const dimensionRule = `必须逐一评价 ${design.dimensions.length} 个指定维度，且只能使用以下标签：${design.dimensions.join("、")}。任一维度低于 85 分时，issues 中必须至少有一条 criterion 与该维度同名的问题；不得只扣分而不解释。`;
  const userText = `请以${design.label}身份独立评审这份 Figma 设计。输入数据：\n${payload}`;
  return [
    { role: "system", content: `${design.systemPrompt}\n\n${dimensionRule}\n\n${outputContract}` },
    {
      role: "user",
      content: request.screenshotBase64
        ? [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: `data:image/png;base64,${request.screenshotBase64}` } },
          ]
        : userText,
    },
  ];
}

function parseModelReview(role: ReviewerRole, content: string, request: ReviewRequest, latencyMs: number): AgentReview {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = modelReviewSchema.parse(JSON.parse(cleaned));
  const expectedDimensions = ROLE_DESIGNS[role].dimensions;
  const receivedDimensionLabels = parsed.dimensions.map((dimension) => dimension.label);
  if (
    receivedDimensionLabels.length !== expectedDimensions.length
    || new Set(receivedDimensionLabels).size !== expectedDimensions.length
    || expectedDimensions.some((dimension) => !receivedDimensionLabels.includes(dimension))
  ) {
    throw new SyntaxError(`模型未按要求返回${ROLE_DESIGNS[role].label}的固定评分维度。`);
  }
  const allowedBasisIds = new Set(getReviewBasesForRole(role).map((basis) => basis.id));
  if (parsed.issues.some((issue) => issue.basisIds.some((basisId) => !allowedBasisIds.has(basisId)))) {
    throw new SyntaxError("模型引用了不适用于该角色的评审依据。");
  }
  const nodesById = new Map(request.scan.nodes.map((node) => [node.id, node]));
  const severityRank = { high: 0, medium: 1, low: 2 } as const;
  const issues = parsed.issues
    .filter((issue) => issue.primaryNodeId === null || issue.primaryNodeId === undefined || nodesById.has(issue.primaryNodeId))
    .map((issue, index) => {
      const validRelatedNodeIds = [...new Set(issue.relatedNodeIds)]
        .filter((nodeId) => nodesById.has(nodeId));
      const primaryNodeId = issue.primaryNodeId ?? validRelatedNodeIds[0] ?? null;
      return {
        id: `${role}-${index + 1}`,
        nodeId: primaryNodeId,
        nodeName: primaryNodeId ? nodesById.get(primaryNodeId)?.name ?? null : null,
        relatedNodes: validRelatedNodeIds
          .filter((nodeId) => nodeId !== primaryNodeId)
          .slice(0, 3)
          .map((nodeId) => ({ nodeId, nodeName: nodesById.get(nodeId)?.name ?? "未命名节点" })),
        severity: issue.severity,
        criterion: issue.criterion,
        aspect: issue.aspect,
        direction: issue.direction,
        title: issue.title
          .replace(/(?:缺乏|缺少)(?:足够的?)?呼吸感|呼吸感不足/g, "间距太小")
          .replace(/视觉节奏(?:失衡|断裂)/g, "排列或间距不一致")
          .replace(/层次感不足/g, "主次区分不明显")
          .replace(/视觉噪音/g, "干扰注意力的元素过多"),
        evidence: issue.evidence,
        basisIds: issue.basisIds as ReviewBasisId[],
        explanation: issue.explanation,
        suggestion: issue.suggestion,
      };
    })
    .sort((left, right) => severityRank[left.severity] - severityRank[right.severity])
    .slice(0, MAX_ROLE_ISSUES);
  return {
    role,
    focus: ROLE_DESIGNS[role].focus,
    score: Math.round(parsed.score),
    dimensions: parsed.dimensions.map((item) => ({ ...item, score: Math.round(item.score) })),
    summary: parsed.summary,
    issues,
    status: "completed",
    latencyMs,
    error: null,
  };
}

export class ReviewService {
  private readonly client: BailianClient;

  constructor(private readonly config: ServerConfig, client?: BailianClient) {
    this.client = client ?? new BailianClient(config);
  }

  async review(request: ReviewRequest): Promise<ReviewResponse> {
    const startedAt = Date.now();
    const reviews = await Promise.all(REVIEWER_ROLES.map(async (role): Promise<AgentReview> => {
      const roleStartedAt = Date.now();
      try {
        if (this.config.mockMode) return mockReview(role, request, Date.now() - roleStartedAt);
        const messages = buildReviewMessages(role, request);
        let parseError: unknown;
        for (let outputAttempt = 0; outputAttempt < 2; outputAttempt += 1) {
          const completion = await this.client.complete({
            messages,
            jsonMode: true,
            temperature: 0.2,
          });
          try {
            return parseModelReview(role, completion.content, request, Date.now() - roleStartedAt);
          } catch (error) {
            parseError = error;
            if (!(error instanceof z.ZodError || error instanceof SyntaxError) || outputAttempt === 1) {
              throw error;
            }
          }
        }
        throw parseError;
      } catch (error) {
        const errorMessage = error instanceof z.ZodError || error instanceof SyntaxError
          ? "模型连续两次返回的结构都无法解析，请重新运行该角色评审。"
          : error instanceof Error
            ? error.message
            : "Unknown review error";
        return {
          role,
          focus: ROLE_DESIGNS[role].focus,
          score: 0,
          dimensions: [],
          summary: "该角色未能完成评审。",
          issues: [],
          status: "failed",
          latencyMs: Date.now() - roleStartedAt,
          error: errorMessage,
        };
      }
    }));
    const relationships = analyzeReviewRelationships(reviews);
    const compositeScore = calculateCompositeScore(reviews);
    const coordination = await coordinateReviews(
      this.config,
      this.client,
      reviews,
      relationships,
      compositeScore,
    );
    return {
      reviews,
      coordination,
      compositeScore,
      incomplete: reviews.some((review) => review.status === "failed") || coordination.status !== "completed",
      elapsedMs: Date.now() - startedAt,
      mock: this.config.mockMode,
    };
  }
}
