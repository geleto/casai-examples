import 'dotenv/config';

import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { withProgressIndicator } from './model-logging';

const showProgressIndicators = true;

export const basicProviderName = 'openai';
export const advancedProviderName = 'anthropic';
export const defaultTemperature = 0.2;

export function createTemperatureConfig(providerName: string, temperature = defaultTemperature) {
	return providerName === 'openai' ? {} : { temperature };
}

export const basicTemperatureConfig = createTemperatureConfig(basicProviderName);

export const advancedTemperatureConfig = createTemperatureConfig(advancedProviderName);

// Export wrapped models with progress indicators
export const basicModel = withProgressIndicator(
	openai('gpt-5.4-nano'),
	'GPT-5-nano',
	showProgressIndicators
);

export const advancedModel = withProgressIndicator(
	anthropic('claude-haiku-4-5'),
	'Claude-4.5-Haiku',
	showProgressIndicators
);

export const embeddingModel = openai.embedding('text-embedding-3-small');
