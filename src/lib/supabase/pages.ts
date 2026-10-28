// Read every row of a query, 1,000 at a time. Supabase returns at most 1,000
// rows per request, so a plain .limit(20000) silently stops at 1,000.
type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

export async function allRows<T>(page: (from: number, to: number) => Page<T>, max = 50_000): Promise<{ data: T[]; error: { message: string } | null }> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) return { data: out, error };
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return { data: out, error: null };
}
