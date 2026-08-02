import { z } from "zod";
import type { BailianClient, ChatMessage } from "./bailian-client";
import type { ServerConfig } from "./config";
import {
  type AgentReview,
  type CompositeScore,
  type CoordinationPerspective,
  type CoordinationResult,
  type ReviewConflict,
  type ReviewConsensus,
  type ReviewDifference,
  type ReviewTradeoff,
} from "../src/shared/review";

const tradeoffSchema = z.object({
  conflictId: z.string().min(1),
  topic: z.string().min(1).max(100),
  tradeoffSummary: z.string().min(1).max(240),
  coordinatedSuggestion: z.string().min(1).max(240),
  unresolvedNote: z.string().max(240).default(""),
});

const perspectiveSchema = z.object({
  role: z.enum(["visual", "accessibility", "interaction"]),
  summary: z.string().min(12).max(60),
});

const coordinationSchema = z.object({
  perspectives: z.array(perspectiveSchema).min(2).max(3),
  overallSummary: z.string().min(30).max(100),
  tradeoffs: z.array(tradeoffSchema).max(20),
});

type Relationships = {
  consensus: ReviewConsensus[];
  differences: ReviewDifference[];
  conflicts: ReviewConflict[];
};

function compactReviews(reviews: readonly AgentReview[]) {
  return reviews
    .filter((review) => review.status === "completed")
    .map((review) => ({
      role: review.role,
      score: review.score,
      summary: review.summary,
      dimensions: review.dimensions,
      issues: review.issues.map((issue) => ({
        id: issue.id,
        nodeId: issue.nodeId,
        nodeName: issue.nodeName,
        severity: issue.severity,
        criterion: issue.criterion,
        aspect: issue.aspect,
        direction: issue.direction,
        title: issue.title,
        evidence: issue.evidence,
        explanation: issue.explanation,
        suggestion: issue.suggestion,
      })),
    }));
}

export function buildCoordinationMessages(
  reviews: readonly AgentReview[],
  relationships: Relationships,
  compositeScore: CompositeScore,
): ChatMessage[] {
  const payload = {
    compositeScore,
    expertReviews: compactReviews(reviews),
    relationships,
  };
  return [
    {
      role: "system",
      content: `你是 CritiqueCrew 的评审协调者。你负责整合视觉设计师、无障碍专家和交互设计师已经完成的评审，帮助用户理解整体表现和改进顺序；你不是新的评审专家，也不是替用户裁决的仲裁者。

【核心任务】
1. 为每个成功返回的专家生成一条独立的 perspective：视觉设计师概括视觉层级和版式表现；无障碍专家概括内容理解和包容性风险；交互设计师概括任务路径、反馈和误操作风险。不得遗漏成功返回的视角，也不得加入失败视角。
2. perspective 应优先压缩对应专家原有 summary，保留该专家原本的判断重点和表达顺序，再结合 dimensions 和 issues 校正。每条只写一句话，建议 25 至 50 个字符。根据证据自然决定侧重优点、问题或整体判断，不要求每条都同时包含“优点+缺点”；三条不得套用相同的转折结构，尤其不要连续使用“……清晰，但……”这类模板。表达保持客观，但不要为了形式平衡而捏造优点。
3. overallSummary 是跨视角的综合归纳，不再从视觉、无障碍、交互三个方面逐项复述。用一至两句话概括整体水平、多个视角共同反映出的主要问题及最值得优先关注的方向，建议 50 至 90 个字符。优先使用“整体……”或“综合来看，……”形成明确的总结性开头，但根据实际结果自然选择，不使用完全固定的模板。
4. 对每个输入 conflict 生成一项 tradeoff：并列保留原始意见，概括各方分别希望保护的目标，说明核心权衡，并给出一个可执行但不宣称唯一正确的协调建议。
5. 如果现有证据不足以形成可靠折中，仍要保留双方观点，并在 unresolvedNote 中说明还需要结合哪些产品目标或使用情境确认；不得向用户提出需要回复的问题。

【执行边界】
- 不重新查看或评审设计，不创造专家没有提出的新问题。
- evidence 是可核对事实，explanation 是影响判断，suggestion 只是专家建议；不得把 suggestion 当作事实。
- perspectives、overallSummary 和 tradeoffs 中所有面向用户的语句必须使用中文。除 px、pt、rem、ms、s 等计量单位外，不得穿插英文单词或英文缩写；输入中的英文术语必须先改写成通俗中文，例如将 padding 改为“内边距”。
- 保留共识、判断差异和方向分歧，不强制把不同视角收敛为单一结论。
- 不选出“胜出专家”，不使用“最终裁决”“必须采用”等绝对表述。
- 没有 conflict 时 tradeoffs 必须为空；每个 conflict 有且只有一项 tradeoff。

只输出合法 JSON：
{
  "perspectives": [{
    "role": "visual|accessibility|interaction，必须与成功返回的专家一致",
    "summary": "该专家最核心的一句话，建议25至50个字符，最多60个字符"
  }],
  "overallSummary": "不重复三个专家、只做跨视角归纳的一至两句话，建议50至90个字符，最多100个字符",
  "tradeoffs": [{
    "conflictId": "必须来自 relationships.conflicts",
    "topic": "权衡议题标题",
    "tradeoffSummary": "双方目标及核心取舍，不超过240个字符",
    "coordinatedSuggestion": "可执行的协调建议，不超过240个字符",
    "unresolvedNote": "不能完全协调时说明仍需确认的信息；否则为空字符串"
  }]
}`,
    },
    { role: "user", content: `请整合以下多视角评审结果：\n${JSON.stringify(payload)}` },
  ];
}

function parseCoordination(
  content: string,
  reviews: readonly AgentReview[],
  conflicts: readonly ReviewConflict[],
): { perspectives: CoordinationPerspective[]; overallSummary: string; tradeoffs: ReviewTradeoff[] } {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = coordinationSchema.parse(JSON.parse(cleaned));
  const expectedRoles = new Set(reviews.map((review) => review.role));
  const perspectiveRoles = parsed.perspectives.map((item) => item.role);
  if (
    new Set(perspectiveRoles).size !== perspectiveRoles.length
    || perspectiveRoles.length !== expectedRoles.size
    || perspectiveRoles.some((role) => !expectedRoles.has(role))
  ) {
    throw new SyntaxError("总体评价的专家要点必须与成功返回的专家逐一对应。");
  }
  const conflictsById = new Map(conflicts.map((conflict) => [conflict.id, conflict]));
  if (parsed.tradeoffs.length !== conflicts.length) {
    throw new SyntaxError("协调结果必须逐一覆盖全部方向分歧。");
  }
  const seen = new Set<string>();
  for (const tradeoff of parsed.tradeoffs) {
    if (!conflictsById.has(tradeoff.conflictId) || seen.has(tradeoff.conflictId)) {
      throw new SyntaxError("协调结果包含无效或重复的方向分歧 ID。");
    }
    seen.add(tradeoff.conflictId);
  }
  return parsed;
}

function baseResult(relationships: Relationships): Pick<CoordinationResult, "consensus" | "differences" | "conflicts"> {
  return relationships;
}

export async function coordinateReviews(
  config: ServerConfig,
  client: BailianClient,
  reviews: readonly AgentReview[],
  relationships: Relationships,
  compositeScore: CompositeScore,
): Promise<CoordinationResult> {
  const successfulReviews = reviews.filter((review) => review.status === "completed");
  if (successfulReviews.length < 2) {
    return {
      ...baseResult(relationships),
      status: "skipped",
      perspectives: [],
      tradeoffs: [],
      overallSummary: "成功返回的专家视角不足两个，暂时无法形成可靠的多视角综合评价。",
      latencyMs: 0,
      error: null,
    };
  }

  const startedAt = Date.now();
  if (config.mockMode) {
    return {
      ...baseResult(relationships),
      status: "completed",
      perspectives: successfulReviews.map((review) => ({
        role: review.role,
        summary: review.role === "visual"
          ? "页面层级和基础结构易于识别，局部视觉重点、留白和样式一致性仍需调整。"
          : review.role === "accessibility"
            ? "内容关系基本可以理解；当前主要短板是可读性、信息说明和不同用户的使用风险。"
            : "主要任务入口明确，后续应补全操作反馈、状态说明与误操作防护。",
      })),
      tradeoffs: relationships.conflicts.map((conflict) => ({
        conflictId: conflict.id,
        topic: `${conflict.nodeName}的${conflict.aspect}需要权衡`,
        tradeoffSummary: "不同视角分别关注信息层级与任务可发现性，两者都具有合理目标。",
        coordinatedSuggestion: "保留操作入口的清晰位置和文字说明，同时控制视觉强调程度，使其可发现但不压过页面主要内容。",
        unresolvedNote: "",
      })),
      overallSummary: "整体完成度中等，页面已经具备基本的信息组织和任务框架，但关键内容的辨识、理解与操作衔接还不够稳定，细节一致性和风险防护也有明显完善空间。建议优先处理会同时影响信息理解与任务完成的问题。",
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const completion = await client.complete({
        messages: buildCoordinationMessages(successfulReviews, relationships, compositeScore),
        jsonMode: true,
        temperature: 0.1,
      });
      const parsed = parseCoordination(completion.content, successfulReviews, relationships.conflicts);
      return {
        ...baseResult(relationships),
        status: "completed",
        ...parsed,
        latencyMs: Date.now() - startedAt,
        error: null,
      };
    } catch (error) {
      lastError = error;
    }
  }

  const message = lastError instanceof Error ? lastError.message : "未知协调错误";
  return {
    ...baseResult(relationships),
    status: "failed",
    perspectives: [],
    tradeoffs: [],
    overallSummary: "多视角关系已保留，但评审协调者未能返回有效的总体评价。",
    latencyMs: Date.now() - startedAt,
    error: message,
  };
}
