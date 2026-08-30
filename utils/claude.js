/* ══════════════════════════════════════════════════════════════
   Claude (Anthropic) client — the LLM layer that turns FlowGuard's
   structured, already-computed risk intelligence into plain-language
   briefings. It NEVER computes risk; it only phrases the numbers the
   risk engine produced. The grounding prompt forbids inventing figures.

   Config (server environment):
     ANTHROPIC_API_KEY   required to enable real Claude output
     ANTHROPIC_MODEL     optional, defaults below — set to the model your
                         account uses (e.g. a current Sonnet)
   With no key, callers fall back to a deterministic template so the
   feature works before the key is added.
   ══════════════════════════════════════════════════════════════ */

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
const API_URL = 'https://api.anthropic.com/v1/messages';

function hasKey() { return !!process.env.ANTHROPIC_API_KEY; }

// Returns { ok, text, model } | { ok:false, reason, status?, detail? }
async function askClaude({ system, user, maxTokens = 700, temperature = 0.2 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, reason: 'no_key' };
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).slice(0, 300);
      return { ok: false, reason: 'api_error', status: r.status, detail };
    }
    const j = await r.json();
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    return { ok: true, text, model: MODEL };
  } catch (err) {
    return { ok: false, reason: 'network', detail: String(err && err.message || err).slice(0, 200) };
  }
}

module.exports = { askClaude, hasKey, MODEL };
