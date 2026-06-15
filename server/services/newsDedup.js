/**
 * 新闻近似重复判定(纯函数,可测试)。
 *
 * 同一个底层事件经常被同一家媒体/新闻稿渠道以几乎一字不差的标题反复推送
 * (典型如证券集体诉讼律所的批量新闻稿)。LLM 事件归并(matchEvent)偶尔会把
 * 这类近似重复漏判成不同事件,导致同一利空/利好被重复计分、甚至重复交易。
 * 这里提供一套确定性的相似度判定,作为 LLM 归并的兜底,并复用于公司抽屉的展示聚合。
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at',
  'by', 'from', 'as', 'is', 'are', 'be', 'inc', 'corp', 'ltd', 'co', 'plc',
]);

/** 归一化:转小写、去除标点/控制符、压缩空白。用于相似度比较前的预处理。 */
export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // 保留字母/数字,其余(标点/控制符)视作分隔
    .replace(/\s+/g, ' ')
    .trim();
}

/** 归一化后的去停用词 token 集合 */
export function tokenSet(text) {
  const tokens = normalizeText(text)
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t));
  return new Set(tokens);
}

/** 两个 token 集合(或文本)的 Jaccard 相似度(交集/并集),空集返回 0 */
export function jaccardSimilarity(a, b) {
  const setA = a instanceof Set ? a : tokenSet(a);
  const setB = b instanceof Set ? b : tokenSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 判断两条报道是否近似重复:对(标题、事件归纳)分别算 Jaccard,取最大值。
 * 任一文本对的相似度 ≥ threshold 即视为同一事件的重复报道。
 */
export function isNearDuplicate(a, b, threshold = 0.8) {
  const titleSim = jaccardSimilarity(a.title || '', b.title || '');
  const summarySim = jaccardSimilarity(a.summary || '', b.summary || '');
  return Math.max(titleSim, summarySim) >= threshold;
}

/**
 * 从一组同票历史事件里找出与新报道最相似且达标的事件(确定性归并兜底)。
 * events 形如 news_events 行(含 summary / sentiment),incoming 形如
 * { title, summary, sentiment }。仅在同方向(sentiment 相同)时归并,
 * 返回 { event, similarity } 或 null。
 */
export function findDuplicateEvent(incoming, events, threshold = 0.8) {
  let best = null;
  let bestSim = 0;
  for (const event of events || []) {
    if (event.sentiment && incoming.sentiment && event.sentiment !== incoming.sentiment) continue;
    const titleSim = jaccardSimilarity(incoming.title || '', event.summary || '');
    const summarySim = jaccardSimilarity(incoming.summary || '', event.summary || '');
    const sim = Math.max(titleSim, summarySim);
    if (sim >= threshold && sim > bestSim) {
      best = event;
      bestSim = sim;
    }
  }
  return best ? { event: best, similarity: bestSim } : null;
}

/**
 * 公司抽屉用的展示聚合:把同一标的的分析行(news_analyses,含 news_articles 关联)
 * 聚成事件簇。先按非空 event_id 归并,再把代表项的标题/事件归纳近似且同方向的簇合并。
 * 代表项取档位最高 → 综合置信度最高 → 最新者。
 * 返回数组,每项 { representative, members, article_count, sources },按代表项时间倒序。
 */
export function clusterAnalyses(analyses, threshold = 0.8) {
  const clusters = [];
  const byEventId = new Map();

  const keyOf = (a) => ({
    title: a.news_articles?.title || '',
    summary: a.event_summary || a.news_articles?.title || '',
    sentiment: a.sentiment,
  });

  for (const a of analyses || []) {
    // 1) event_id 命中已有簇:直接归入(同一底层事件,后台已归并)
    if (a.event_id != null && byEventId.has(a.event_id)) {
      byEventId.get(a.event_id).members.push(a);
      continue;
    }
    // 2) 与已有簇代表项近似且同方向:合并(兜底 event_id 漏判的历史数据)
    const incoming = keyOf(a);
    const hit = clusters.find(
      (c) =>
        c.sentiment === a.sentiment &&
        isNearDuplicate(incoming, keyOf(c.members[0]), threshold)
    );
    if (hit) {
      hit.members.push(a);
      if (a.event_id != null && !byEventId.has(a.event_id)) byEventId.set(a.event_id, hit);
      continue;
    }
    // 3) 新簇
    const cluster = { sentiment: a.sentiment, members: [a] };
    clusters.push(cluster);
    if (a.event_id != null) byEventId.set(a.event_id, cluster);
  }

  const tierRank = (a) => (a.tier ? 5 - a.tier : 0); // 第1档最高
  const time = (a) => new Date(a.created_at || 0).getTime();
  return clusters
    .map((c) => {
      const members = [...c.members].sort((x, y) => {
        const t = tierRank(y) - tierRank(x);
        if (t !== 0) return t;
        const fc = (Number(y.final_confidence) || 0) - (Number(x.final_confidence) || 0);
        if (fc !== 0) return fc;
        return time(y) - time(x);
      });
      const representative = members[0];
      const sources = [
        ...new Set(
          members.map((m) => m.news_articles?.publisher || m.news_articles?.source).filter(Boolean)
        ),
      ];
      return { representative, members, article_count: members.length, sources };
    })
    .sort((a, b) => time(b.representative) - time(a.representative));
}
