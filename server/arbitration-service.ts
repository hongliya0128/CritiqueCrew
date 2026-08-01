import { z } from "zod";
import type { BailianClient, ChatMessage } from "./bailian-client";
import type { ServerConfig } from "./config";
import type {
  ArbitrationDecision,
  ArbitrationResult,
  ReviewConflict,
  ReviewConsensus,
  ReviewDifference,
} from "../src/shared/review";

const arbitrationSchema = z.object({
  summary: z.string().min(1).max(320),
  decisions: z.array(z.object({
    conflictId: z.string().min(1),
    priority: z.enum(["high", "medium", "low"]),
    resolution: z.string().min(1).max(240),
    rationale: z.string().min(1).max(240),
    preferredIssueIds: z.array(z.string().min(1)).max(10),
  })).max(20),
});

type Relationships = {
  consensus: ReviewConsensus[];
  differences: ReviewDifference[];
  conflicts: ReviewConflict[];
};

export function buildArbitrationMessages(conflicts: readonly ReviewConflict[]): ChatMessage[] {
  const payload = conflicts.map((conflict) => ({
    conflictId: conflict.id,
    nodeId: conflict.nodeId,
    nodeName: conflict.nodeName,
    aspect: conflict.aspect,
    reason: conflict.reason,
    opinions: conflict.issues,
  }));
  return [
    {
      role: "system",
      content: `你是 CritiqueCrew 的仲裁者。你只处理已经识别出的方向冲突，不重新评审整个设计。
必须保留各角色原始意见，并逐条使用 evidence 核对观察事实、使用 explanation 理解问题影响，再结合用户任务影响和建议可执行性作出综合判断。
不得把 suggestion 当作事实证据；证据不足时应在 rationale 中明确说明不确定性。
不要因为角色名称而固定偏向某一方；如果两方都有价值，可以提出明确的折中方案。
只输出合法 JSON：
{
  "summary": "仲裁总体结论",
  "decisions": [{
    "conflictId": "必须来自输入",
    "priority": "high|medium|low",
    "resolution": "最终建议或折中方案，不超过240个字符",
    "rationale": "为什么这样判断，不超过240个字符",
    "preferredIssueIds": ["被采纳或优先吸收的原始 issue ID"]
  }]
}
每一个输入冲突都必须有且只有一条 decision，不得虚构 conflictId 或 issue ID。
resolution 和 rationale 必须分别控制在 240 个字符以内；使用简洁完整的句子，不得通过重复背景、证据或原始意见拉长内容。`,
    },
    { role: "user", content: `请仲裁以下冲突：\n${JSON.stringify(payload)}` },
  ];
}

function parseArbitration(content: string, conflicts: readonly ReviewConflict[]): {
  summary: string;
  decisions: ArbitrationDecision[];
} {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = arbitrationSchema.parse(JSON.parse(cleaned));
  const conflictsById = new Map(conflicts.map((conflict) => [conflict.id, conflict]));
  if (parsed.decisions.length !== conflicts.length) {
    throw new SyntaxError("仲裁结果必须逐一覆盖全部冲突。");
  }
  const seen = new Set<string>();
  for (const decision of parsed.decisions) {
    const conflict = conflictsById.get(decision.conflictId);
    if (!conflict || seen.has(decision.conflictId)) throw new SyntaxError("仲裁结果包含无效或重复的冲突 ID。");
    const allowedIssueIds = new Set(conflict.issues.map((issue) => issue.issueId));
    if (decision.preferredIssueIds.some((issueId) => !allowedIssueIds.has(issueId))) {
      throw new SyntaxError("仲裁结果引用了不属于该冲突的意见 ID。");
    }
    seen.add(decision.conflictId);
  }
  return parsed;
}

function baseResult(relationships: Relationships): Pick<ArbitrationResult, "consensus" | "differences" | "conflicts"> {
  return relationships;
}

export async function arbitrateRelationships(
  config: ServerConfig,
  client: BailianClient,
  relationships: Relationships,
  successfulReviewerCount: number,
): Promise<ArbitrationResult> {
  if (successfulReviewerCount < 2) {
    return {
      ...baseResult(relationships),
      status: "skipped",
      decisions: [],
      summary: "成功返回的评审角色不足两个，未运行仲裁。",
      latencyMs: 0,
      error: null,
    };
  }
  if (relationships.conflicts.length === 0) {
    return {
      ...baseResult(relationships),
      status: "not-needed",
      decisions: [],
      summary: "未发现修改方向互斥的意见，因此不需要仲裁。",
      latencyMs: 0,
      error: null,
    };
  }

  const startedAt = Date.now();
  if (config.mockMode) {
    return {
      ...baseResult(relationships),
      status: "completed",
      decisions: relationships.conflicts.map((conflict) => ({
        conflictId: conflict.id,
        priority: "medium",
        resolution: "保留入口的可发现性，同时降低非关键装饰的视觉重量，用层级而不是单纯增减颜色强度解决矛盾。",
        rationale: "交互入口需要被看见，但不应压过页面主任务；两方关注点可以通过分层处理同时满足。",
        preferredIssueIds: conflict.issues.map((issue) => issue.issueId),
      })),
      summary: `Mock 仲裁已处理 ${relationships.conflicts.length} 项方向冲突，并保留全部原始意见。`,
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const completion = await client.complete({
        messages: buildArbitrationMessages(relationships.conflicts),
        jsonMode: true,
        temperature: 0.1,
      });
      const parsed = parseArbitration(completion.content, relationships.conflicts);
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

  const message = lastError instanceof Error ? lastError.message : "未知仲裁错误";
  return {
    ...baseResult(relationships),
    status: "failed",
    decisions: [],
    summary: "冲突已识别，但仲裁者未能返回有效结果；原始意见仍完整保留。",
    latencyMs: Date.now() - startedAt,
    error: message,
  };
}
