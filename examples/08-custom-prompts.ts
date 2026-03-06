/**
 * 08-custom-prompts.ts
 *
 * Override the default system and user prompts to tune the LLM's tone,
 * style, or domain focus. Template variables are interpolated at runtime.
 *
 * Available variables:
 *   {{sourceLocale}}   — e.g. "en"
 *   {{targetLocales}}  — e.g. "fr, de"
 *   {{namespace}}      — e.g. "checkout"
 *   {{context}}        — value of config.context
 *   {{json}}           — the JSON chunk to translate (user prompt only)
 *
 * Run:
 *   GEMINI_API_KEY=... npx ts-node examples/08-custom-prompts.ts
 */

import { translate } from '@mihairo/loqui';

await translate({
  input: './en.json',
  from: 'en',
  to: ['fr', 'de'],
  output: './i18n/{locale}.json',
  namespace: 'marketing',
  config: {
    engine: 'gemini',
    model: 'gemini-2.5-flash',
    temperature: 0.3,   // slightly higher for more natural marketing copy
    topP: 1,
    concurrency: 8,
    splitToken: 4000,
    context: 'B2B SaaS product for HR teams',
    prompts: {
      system: [
        'You are a senior copywriter and professional translator.',
        'You are localising marketing copy for a {{context}} from {{sourceLocale}} into {{targetLocales}}.',
        'Maintain a confident, professional tone. Adapt idioms naturally for each culture.',
        'Rules:',
        '1. Output only valid JSON — no markdown, no explanations.',
        '2. Top-level keys must be the locale codes: {{targetLocales}}.',
        '3. Preserve all opaque mask tokens like ⟦0⟧ exactly as-is.',
      ].join('\n'),
      user: 'Translate this {{namespace}} copy:\n\n{{json}}',
    },
  },
});
