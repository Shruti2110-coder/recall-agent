import { google, type GoogleLanguageModelOptions } from '@ai-sdk/google';
import { groq } from '@ai-sdk/groq';
import type { LanguageModel } from 'ai';

// One model we can try, with its provider-specific settings.
export type Candidate = {
  name: string;
  model: LanguageModel;
  providerOptions?: Record<string, Record<string, unknown>>;
};

// The models to try, in order. The first is used; the next is the backup.
// Which ones are in the list depends on which API keys are in .env.local.
// PRIMARY_MODEL=google puts Gemini first; the default is Groq first.
export function getModels(env: Record<string, string | undefined> = process.env): Candidate[] {
  const list: Candidate[] = [];

  // Groq runs open models on very fast hardware, so by default it goes first.
  // Reasoning is 'medium': on 'low' it was sometimes careless with dates and CHANGED/UNCHANGED labels.
  if (env.GROQ_API_KEY) {
    const id = env.GROQ_MODEL_ID ?? 'openai/gpt-oss-120b';
    list.push({
      name: 'groq/' + id,
      model: groq(id),
      providerOptions: { groq: { reasoningEffort: 'medium' } },
    });
  }

  if (env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const id = env.MODEL_ID ?? 'gemini-3.5-flash-lite';
    list.push({
      name: 'google/' + id,
      model: google(id),
      providerOptions: {
        google: { thinkingConfig: { thinkingLevel: 'minimal' } } satisfies GoogleLanguageModelOptions,
      },
    });
  }

  // Move the chosen provider to the front, if its key is set.
  const primary = env.PRIMARY_MODEL?.trim().toLowerCase();
  if (primary === 'groq' || primary === 'google') {
    const index = list.findIndex((candidate) => candidate.name.startsWith(primary + '/'));
    if (index > 0) list.unshift(...list.splice(index, 1));
  }

  return list;
}
