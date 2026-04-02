import type { EngineAdapter, LoquiConfig } from '../types.js';

export async function createEngine(config: LoquiConfig, engineOverride?: EngineAdapter): Promise<EngineAdapter> {
  if (engineOverride) return engineOverride;

  switch (config.engine) {
    case 'gemini': {
      const { GeminiEngine } = await import('./gemini.engine.js');
      return new GeminiEngine(config);
    }
    case 'openai': {
      const { OpenAIEngine } = await import('./openai.engine.js');
      return new OpenAIEngine(config);
    }
    case 'anthropic': {
      const { AnthropicEngine } = await import('./anthropic.engine.js');
      return new AnthropicEngine(config);
    }
    default: {
      const _exhaustive: never = config.engine;
      throw new Error(`Unknown engine: '${_exhaustive}'`);
    }
  }
}
