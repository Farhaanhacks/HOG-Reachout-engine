import { getJson, type Services } from './services';

/** Reads a JSON object out of a model reply, tolerating ```json fences and text around it. Returns null if there is none. */
export function parseJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const raw = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  for (const candidate of [raw, raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)]) {
    try {
      const data = JSON.parse(candidate);
      if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
    } catch {}
  }
  return null;
}

type DeepSeekResponse = { choices?: { finish_reason?: string; message?: { content?: string } }[] };

/**
 * Asks DeepSeek for a JSON object. Retries once on an unusable reply. Throws when DeepSeek cannot be reached, so the
 * caller can leave the lead for next time.
 */
export async function askDeepSeekJson(svc: Services, system: string, user: string): Promise<Record<string, unknown> | null> {
  if (!svc.keys.deepseek) throw new Error('DEEPSEEK_API_KEY is not set');
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await getJson<DeepSeekResponse>(
      svc,
      'https://api.deepseek.com/chat/completions',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${svc.keys.deepseek}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
          max_tokens: 400,
          temperature: 0.4,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      },
      45_000,
    );
    const choice = res.choices?.[0];
    const data = choice?.finish_reason === 'length' ? null : parseJsonObject(choice?.message?.content);
    if (data) return data;
  }
  return null;
}
