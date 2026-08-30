/* ══════════════════════════════════════════════════════════════
   LLM client — provider-agnostic. Turns FlowGuard's structured,
   already-computed risk numbers into plain-language briefings. It never
   computes risk; the grounding prompt forbids inventing figures.

   Start FREE on Groq (no card), switch to Claude later with ONE env change.

   Config (server environment — set the key on the server, never in git):
     LLM_PROVIDER   groq | openrouter | gemini | anthropic   (default: groq)
     LLM_API_KEY    your provider key
     LLM_MODEL      optional — defaults per provider below
     LLM_BASE_URL   optional — override the API base

   Back-compat: if ANTHROPIC_API_KEY is set and LLM_* are not, it uses Claude.
   ══════════════════════════════════════════════════════════════ */

const PROVIDERS = {
  // OpenAI-compatible chat/completions
  groq:       { mode: 'openai', base: 'https://api.groq.com/openai/v1',            model: 'openai/gpt-oss-20b' },
  openrouter: { mode: 'openai', base: 'https://openrouter.ai/api/v1',              model: 'meta-llama/llama-3.3-70b-instruct:free' },
  gemini:     { mode: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash' },
  // Anthropic messages API
  anthropic:  { mode: 'anthropic', base: 'https://api.anthropic.com',              model: 'claude-3-5-sonnet-latest' },
};

const PROVIDER = (process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY && !process.env.LLM_API_KEY ? 'anthropic' : 'groq')).toLowerCase();
const CFG = PROVIDERS[PROVIDER] || PROVIDERS.groq;
const API_KEY = process.env.LLM_API_KEY || process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.LLM_MODEL || CFG.model;
const BASE = (process.env.LLM_BASE_URL || CFG.base).replace(/\/+$/, '');

function hasKey() { return !!API_KEY; }

// Returns { ok, text, model, provider } | { ok:false, reason, status?, detail? }
async function askLLM({ system, user, maxTokens = 700, temperature = 0.2 }) {
  if (!API_KEY) return { ok: false, reason: 'no_key' };
  try {
    let r, text;
    if (CFG.mode === 'anthropic') {
      r = await fetch(BASE + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!r.ok) return { ok: false, reason: 'api_error', status: r.status, detail: (await r.text().catch(() => '')).slice(0, 300) };
      const j = await r.json();
      text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    } else {
      // OpenAI-compatible: Groq, OpenRouter, Gemini(-openai), etc.
      r = await fetch(BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + API_KEY },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!r.ok) return { ok: false, reason: 'api_error', status: r.status, detail: (await r.text().catch(() => '')).slice(0, 300) };
      const j = await r.json();
      text = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
    }
    return { ok: true, text, model: MODEL, provider: PROVIDER };
  } catch (err) {
    return { ok: false, reason: 'network', detail: String((err && err.message) || err).slice(0, 200) };
  }
}

// askClaude kept as an alias so existing callers keep working.
module.exports = { askLLM, askClaude: askLLM, hasKey, MODEL, PROVIDER };
