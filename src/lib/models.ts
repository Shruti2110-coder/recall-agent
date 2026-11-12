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
export function getModels(): Candidate[] {
  const list: Candidate[] = [];

  // Groq runs open models on very fast hardware, so it goes first.
  if (process.env.GROQ_API_KEY) {
    const id = process.env.GROQ_MODEL_ID ?? 'openai/gpt-oss-120b';
    list.push({
      name: 'groq/' + id,
      model: groq(id),
      providerOptions: { groq: { reasoningEffort: 'low' } },
    });
  }

  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const id = process.env.MODEL_ID ?? 'gemini-3.5-flash-lite';
    list.push({
      name: 'google/' + id,
      model: google(id),
      providerOptions: {
        google: { thinkingConfig: { thinkingLevel: 'minimal' } } satisfies GoogleLanguageModelOptions,
      },
    });
  }

  return list;
}
