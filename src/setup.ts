import 'dotenv/config';

import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { withProgressIndicator } from './model-logging';

const showProgressIndicators = true;
const advancedModelOptions = {
	haiku: {
		model: anthropic('claude-haiku-4-5'),
		providerName: 'anthropic',
		label: 'Claude-4.5-Haiku',
	},
	'gpt-mini': {
		model: openai('gpt-5.4-mini'),
		providerName: 'openai',
		label: 'GPT-5.4-mini',
	},
} as const;
const advancedModelChoice: keyof typeof advancedModelOptions = 'gpt-mini';
const advancedModelSettings = advancedModelOptions[advancedModelChoice];

export const basicProviderName = 'openai';
export const advancedProviderName = advancedModelSettings.providerName;

export const providerOptions = {
	openai: {
		promptCacheKey: 'casai-examples',
	},
	anthropic: {
		structuredOutputMode: 'jsonTool' as const,
	},
};

// Export wrapped models with progress indicators
export const basicModel = withProgressIndicator(
	openai('gpt-5.4-nano'),
	'GPT-5-nano',
	showProgressIndicators
);

export const advancedModel = withProgressIndicator(
	advancedModelSettings.model,
	advancedModelSettings.label,
	showProgressIndicators
);

export const embeddingModel = openai.embedding('text-embedding-3-small');
