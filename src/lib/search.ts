import { getDb } from './db';

export type SearchResult = { title: string; url: string; snippet: string };
export type SearchOutcome = { query: string; results: SearchResult[]; error?: string };

const CACHE_MINUTES = 10;

async function searchOnce(query: string): Promise<SearchOutcome> {
  const db = getDb();
  const key = query.trim().toLowerCase();

  // 1) If we ran this exact search in the last 10 minutes, reuse the result.
  const cached = db.prepare('SELECT results, fetched_at FROM search_cache WHERE query = ?').get(key) as
    | { results: string; fetched_at: string }
    | undefined;
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_MINUTES * 60_000) {
    return { query, results: JSON.parse(cached.results) };
  }

  // 2) Otherwise ask Tavily.
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({ query, max_results: 5 }),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return { query, results: [], error: `Search failed (HTTP ${response.status})` };
    }

    const data = await response.json();
    const results: SearchResult[] = (data.results ?? []).map((item: any) => ({
      title: item.title,
      url: item.url,
      snippet: String(item.content ?? '').slice(0, 1200),
    }));

    // 3) Remember the result for next time.
    db.prepare('INSERT OR REPLACE INTO search_cache (query, results, fetched_at) VALUES (?, ?, ?)').run(
      key,
      JSON.stringify(results),
      new Date().toISOString(),
    );

    return { query, results };
  } catch {
    return { query, results: [], error: 'Search request failed or timed out' };
  }
}

export async function webSearch(queries: string[]): Promise<SearchOutcome[]> {
  return Promise.all(queries.map((query) => searchOnce(query)));
}