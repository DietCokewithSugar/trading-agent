import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: true });

/**
 * 补充新闻源:Yahoo Finance 各股票的 RSS 头条。
 * 仅作为 FMP 之外的补充,失败时静默跳过,不影响主流程。
 */
export async function getYahooNews(symbols, perSymbolLimit = 5) {
  const out = [];
  const targets = [...new Set(symbols)].slice(0, 10);
  await Promise.all(
    targets.map(async (symbol) => {
      try {
        const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) return;
        const xml = parser.parse(await res.text());
        let items = xml?.rss?.channel?.item ?? [];
        if (!Array.isArray(items)) items = [items];
        for (const item of items.slice(0, perSymbolLimit)) {
          if (!item?.link || !item?.title) continue;
          out.push({
            symbol,
            title: String(item.title),
            url: String(item.link),
            text: item.description ? String(item.description) : '',
            // 公开页展示的是 publisher:用 RSS 自带的原始发布方,缺失留空——
            // 抓取渠道名不得出现在公开 UI(约定),可信度打分走 URL 域名不受影响
            publisher: item.source ? String(item.source) : null,
            site: 'finance.yahoo.com',
            publishedDate: item.pubDate ? new Date(item.pubDate).toISOString() : null,
          });
        }
      } catch (err) {
        console.warn(`[yahoo] 抓取 ${symbol} RSS 失败: ${err.message}`);
      }
    })
  );
  return out;
}
