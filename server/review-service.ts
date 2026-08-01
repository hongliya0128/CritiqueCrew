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
import { arbitrateRelationships } from "./arbitration-service";

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
  title: z.string().min(1).max(100),
  evidence: z.string().min(1).max(220),
  basisIds: z.array(z.enum(REVIEW_BASIS_IDS)).max(3).default([]),
  explanation: z.string().min(1).max(220),
  suggestion: z.string().min(1).max(220),
});

const modelReviewSchema = z.object({
  score: z.number().min(0).max(100),
  dimensions: z.array(dimensionSchema).min(3).max(4),
  summary: z.string().min(1).max(320),
  issues: z.array(issueSchema).max(20),
});

type RoleDesign = {
  label: string;
  focus: string;
  systemPrompt: string;
};

const PAGE_SEMANTICS_REVIEW_PROTOCOL = `
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
    systemPrompt: `
你是 CritiqueCrew 的资深视觉设计师。你必须独立评审设计，不要充当 WCAG 规则检查器。

${PAGE_SEMANTICS_REVIEW_PROTOCOL}

只从视觉设计专业角度判断：
1. 信息层级：主次是否一眼可辨，视觉焦点是否符合任务优先级；对于重复内容单元，必须根据页面语义检查核心对象、关键属性、状态、辅助信息与操作入口的视觉权重和阅读顺序；
2. 留白与布局：间距、对齐、密度、分组关系是否形成稳定节奏；
3. 一致性：字体、颜色、圆角、组件形态和重复模式是否统一；
4. 视觉节奏：页面是否拥挤、单调或失衡，阅读路径是否自然；重复条目能否让用户快速纵向比较同类信息。

禁止逐条复述字号、对比度、44px 等自动化规则结果。只有当它们造成明显视觉层级或节奏问题时，才可从视觉角度合并为一个问题。
最多给出 5 个最重要、彼此不重复的问题；同类节点必须合并，不要逐节点列举。
评分维度固定为：信息层级、布局留白、一致性、视觉节奏。
`.trim(),
  },
  accessibility: {
    label: "无障碍专家",
    focus: "感知、理解、操作、包容性",
    systemPrompt: `
你是 CritiqueCrew 的无障碍与可访问性专家。你需要独立判断，不是自动化规则的复读器。

${PAGE_SEMANTICS_REVIEW_PROTOCOL}

从更完整的可访问性角度评审：
1. 感知性：信息是否只依赖颜色、文字与背景是否易读、状态是否可辨；
2. 可理解性：标签、提示、错误信息、文案与信息结构是否清楚；列表项中的身份、时间、状态与操作是否容易建立语义关联；
3. 可操作性：目标是否易点击、操作控件是否可识别、关键任务是否有替代线索；
4. 包容性：低视力、色觉差异、认知负担和不同使用情境下的风险；重复卡片是否支持快速识别与比较，而不要求用户反复回读。

自动化规则仅作为证据线索，不得逐条照抄。相同原因的字号或对比度问题必须合并，并说明它对用户完成任务的真实影响。
至少优先寻找一项自动规则无法覆盖的语义层问题；最多给出 5 个最重要、彼此不重复的问题。
评分维度固定为：感知性、可理解性、可操作性、包容性。
`.trim(),
  },
  interaction: {
    label: "交互设计师",
    focus: "操作路径、反馈、状态、误操作风险",
    systemPrompt: `
你是 CritiqueCrew 的资深交互设计师。你必须独立评审用户如何理解并完成任务。

${PAGE_SEMANTICS_REVIEW_PROTOCOL}

只从交互设计角度判断：
1. 操作路径：主任务入口、步骤顺序和下一步行动是否明确；先判断用户在当前场景中是查看、比较、选择还是管理，再检查界面是否支持这一任务；
2. 反馈明确性：点击、提交、加载、成功、失败是否有及时反馈；
3. 状态可见性：可选、已选、禁用、进行中、完成等状态是否可区分；在重复列表中，状态是否放在容易扫视的位置并与对应对象明确关联；
4. 误操作风险：危险操作、不可逆操作、歧义按钮、误触和恢复路径是否合理。

不要报告纯粹的字号、颜色对比度或静态排版问题，除非它直接导致操作入口不可发现或状态不可辨。
可以提出画面中缺失但任务需要的状态设计；如果缺失状态属于某个现有卡片、按钮、输入框或标签，primaryNodeId 必须定位到该组件。只有问题确实影响整个页面、且不存在任何可作为修改入口的具体节点时，primaryNodeId 才可使用 null。
最多给出 5 个最重要、彼此不重复的问题。
评分维度固定为：操作路径、反馈明确性、状态可见性、误操作防护。
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
        { label: "感知性", score: firstRuleIssue ? 58 : 84, observation: "部分信息对低视力用户不够醒目。" },
        { label: "可理解性", score: 78, observation: "多数标签清楚，但状态说明还可更明确。" },
        { label: "可操作性", score: 72, observation: "主要控件可识别，仍需检查小尺寸触控目标。" },
        { label: "包容性", score: 70, observation: "部分状态较依赖颜色与视觉差异。" },
      ],
      summary: firstRuleIssue ? "存在会影响低视力用户获取信息的风险，建议优先处理。" : "基础可读性尚可，仍需检查状态是否只依赖颜色表达。",
      issues: firstRuleIssue ? [{
        id: "accessibility-1",
        nodeId: firstRuleIssue.nodeId,
        nodeName: firstRuleIssue.nodeName,
        relatedNodes: [],
        severity: "high",
        criterion: "感知性",
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
        { label: "操作路径", score: 78, observation: "主任务入口较清楚，但下一步行动仍可强化。" },
        { label: "反馈明确性", score: 64, observation: "关键操作缺少进行中、成功和失败反馈。" },
        { label: "状态可见性", score: 68, observation: "部分控件状态需要更清晰的视觉与文字提示。" },
        { label: "误操作防护", score: 82, observation: "未见明显危险操作，但恢复路径信息有限。" },
      ],
      summary: "主要操作入口可以识别，但关键操作后的状态反馈不够完整。",
      issues: conflictNode ? [{
        id: "interaction-1", ...conflictNodeInfo, severity: "high", criterion: "操作路径",
        aspect: "visual-prominence", direction: "strengthen",
        title: "关键操作入口不够醒目",
        evidence: "该入口承担主要操作路径，但当前视觉呈现不足以让用户快速发现下一步行动。",
        basisIds: ["NNG-VISIBILITY-OF-STATUS"],
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
    hasPointerInteraction: node.hasPointerInteraction,
  }));
}

function verticalGapEvidence(request: ReviewRequest) {
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
      return ordered.slice(0, -1).map((node, index) => {
        const next = ordered[index + 1];
        const gap = (next.absoluteY ?? 0) - ((node.absoluteY ?? 0) + node.height);
        return {
          parentId: node.parentId,
          from: { id: node.id, name: node.name },
          to: { id: next.id, name: next.name },
          verticalGap: Math.round(gap * 100) / 100,
        };
      });
    })
    .filter((item) => item.verticalGap >= 16)
    .sort((left, right) => right.verticalGap - left.verticalGap)
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
    roleContext: roleContext(role, request),
    allowedReviewBases: basisContext(role),
    ...(role === "visual" ? { layoutEvidence: { largestVerticalGaps: verticalGapEvidence(request) } } : {}),
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
    "title": "一句话具体问题",
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
只有 kind 为 standard 的依据可以表述为“未满足该标准”，且必须有足够的静态证据；kind 为 guideline 或 heuristic 时，只能表述为“设计建议”或“潜在风险”，不得宣称不合规。
涉及两个或多个节点的间距、对齐、层级或流程问题：primaryNodeId 必须选择用户最需要先修改的具体节点，relatedNodeIds 填写其他关联节点。对于垂直间距问题，优先使用 layoutEvidence 中 from 节点作为 primaryNodeId、to 节点作为关联节点；不要为了表示节点关系而选择整个页面共同父容器。
只要问题标题或说明指向某个具体卡片、控件、标签或区域，primaryNodeId 就不得为 null。relatedNodeIds 非空时也必须提供 primaryNodeId。null 仅用于真正无法归属于任何现有节点的全屏结构或全局流程问题。`.trim();
  const dimensionRule = "必须逐一评价四个指定维度。任一维度低于 85 分时，issues 中必须至少有一条 criterion 与该维度同名的问题；不得只扣分而不解释。";
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
        title: issue.title,
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
    const successfulReviewerCount = reviews.filter((review) => review.status === "completed").length;
    const arbitration = await arbitrateRelationships(
      this.config,
      this.client,
      relationships,
      successfulReviewerCount,
    );
    const compositeScore = calculateCompositeScore(reviews);
    return {
      reviews,
      arbitration,
      compositeScore,
      incomplete: reviews.some((review) => review.status === "failed") || arbitration.status === "failed",
      elapsedMs: Date.now() - startedAt,
      mock: this.config.mockMode,
    };
  }
}
