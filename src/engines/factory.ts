import { LoquiConfig, EngineAdapter } from '../types';
import { GeminiEngine } from './gemini.engine';
import { OpenAIEngine } from './openai.engine';
import { AnthropicEngine } from './anthropic.engine';

export function createEngine(config: LoquiConfig, engineOverride?: EngineAdapter): EngineAdapter {
  if (engineOverride) return engineOverride;

  switch (config.engine) {
    case 'gemini':
      return new GeminiEngine(config);
    case 'openai':
      return new OpenAIEngine(config);
    case 'anthropic':
      return new AnthropicEngine(config);
    default: {
      const _exhaustive: never = config.engine;
      throw new Error(`Unknown engine: '${_exhaustive}'`);
    }
  }
}
