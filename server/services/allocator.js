// 资金分配器:候选池统一打分排序 → 冲突消解 → 按分数高低把资金分给最优信号。
// 解决"先到的新闻把现金买光"的路径依赖:谁分高谁先买,资金不足的标记
// capital_constrained 留池,下一轮(或卖出释放现金后)自动复评。
// 本文件上半部为纯函数(打分/合并/排名,node:test 直接测),下半部为编排薄层。
import { tierScore } from './conflictResolver.js';

export { tierScore };

/** 信号时效衰减:与 credibility.recencyScore 同口径(1 小时内 1.0,线性衰减到 24 小时 0.5) */
export function decayFactor(ageHours) {
  if (!Number.isFinite(ageHours) || ageHours < 0) return 0.7;
  if (ageHours <= 1) return 1;
  return Math.max(0.5, 1 - (0.5 * (ageHours - 1)) / 23);
}

/**
 * 候选打分:档位 × LLM 置信度 × 时效衰减 × 来源可信度 × 宏观乘数 × 行业乘数。
 * 缺失置信度/来源分按 0.7 计(与 sizing 链缺省一致)。返回保留三位小数。
 */
export function scoreCandidate(candidate, { now = new Date(), macroMultiplier = 1, sectorMult = 1 } = {}) {
  const nowTs = now instanceof Date ? now.getTime() : Number(now);
  const ageHours = (nowTs - new Date(candidate.created_at || nowTs).getTime()) / 3600_000;
  const conf = Number.isFinite(Number(candidate.confidence)) ? Number(candidate.confidence) : 0.7;
  const src = Number.isFinite(Number(candidate.source_score)) ? Number(candidate.source_score) : 0.7;
  const score =
    tierScore(candidate.tier) * conf * decayFactor(ageHours) * src * macroMultiplier * sectorMult;
  return Number(Math.max(score, 0).toFixed(3));
}

/**
 * 同票候选合并:取最高分者为代表,多事件共振给小幅加成(+0.05/条,上限 +0.1)。
 * 返回 { merged: 代表候选(带 score), absorbed: [{ candidate, into }] }。
 * 输入候选需已带 score 字段。
 */
export function mergeBySymbol(candidates) {
  const groups = new Map();
  for (const c of candidates || []) {
    if (!groups.has(c.symbol)) groups.set(c.symbol, []);
    groups.get(c.symbol).push(c);
  }
  const merged = [];
  const absorbed = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (b.score || 0) - (a.score || 0));
    const rep = group[0];
    const bonus = Math.min(0.05 * (group.length - 1), 0.1);
    merged.push({ ...rep, score: Number(((rep.score || 0) + bonus).toFixed(3)) });
    for (const other of group.slice(1)) absorbed.push({ candidate: other, into: rep });
  }
  return { merged, absorbed };
}

/** 排名:分数降序;同分按综合置信度降序、入池时间升序(先到先得只在同分时生效) */
export function rankCandidates(candidates) {
  return [...(candidates || [])].sort((a, b) => {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const confDiff = (Number(b.final_confidence) || 0) - (Number(a.final_confidence) || 0);
    if (confDiff !== 0) return confDiff;
    return new Date(a.created_at || 0) - new Date(b.created_at || 0);
  });
}

/**
 * 本轮执行计划:取排名前 maxPerRun 个(LLM 交易决策只对这些头部候选发生,
 * 其余留池下轮复评);minScore 过滤掉衰减后已无意义的尾部分数。
 */
export function planAllocations({ ranked, maxPerRun = 3, minScore = 0.05 } = {}) {
  return (ranked || []).filter((c) => (c.score || 0) >= minScore).slice(0, Math.max(maxPerRun, 0));
}
