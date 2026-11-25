// One place that talks to Claude (Anthropic API, ANTHROPIC_API_KEY on the server).
// Every caller has a no-AI fallback: without the key ClaimOne still works.
// Never log prompts or answers — they carry patient data.

export const aiOn = () => !!process.env.ANTHROPIC_API_KEY;

export async function askClaude(system: string, user: string, maxTokens = 1200): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        max_tokens: maxTokens, system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) { console.error('claude: status', res.status); return null; }
    const out = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[] } | null;
    return out?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('').trim() || null;
  } catch { return null; }
}
