import 'dotenv/config';

import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { withProgressIndicator } from './model-logging';
import type { ModelPricing } from './model-logging';

const showProgressIndicators = true;
// Manual USD per 1M token prices for rough log estimates.
// Checked 2026-07-03 from official OpenAI and Anthropic API pricing pages.
const modelPricing = {
	gpt54Nano: {
		inputUsdPerMillion: 0.20,
		cachedInputUsdPerMillion: 0.02,
		outputUsdPerMillion: 1.25,
	},
	gpt54Mini: {
		inputUsdPerMillion: 0.75,
		cachedInputUsdPerMillion: 0.075,
		outputUsdPerMillion: 4.50,
	},
	claude45Haiku: {
		inputUsdPerMillion: 1.00,
		cachedInputUsdPerMillion: 0.10,
		cacheWriteUsdPerMillion: 1.25,
		outputUsdPerMillion: 5.00,
	},
} satisfies Record<string, ModelPricing>;

const advancedModelOptions = {
	haiku: {
		model: anthropic('claude-haiku-4-5'),
		providerName: 'anthropic',
		label: 'Claude-4.5-Haiku',
		pricing: modelPricing.claude45Haiku,
	},
	'gpt-mini': {
		model: openai('gpt-5.4-mini'),
		providerName: 'openai',
		label: 'GPT-5.4-mini',
		pricing: modelPricing.gpt54Mini,
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
	'GPT-5.4-nano',
	showProgressIndicators,
	modelPricing.gpt54Nano
);

export const advancedModel = withProgressIndicator(
	advancedModelSettings.model,
	advancedModelSettings.label,
	showProgressIndicators,
	advancedModelSettings.pricing
);

export const embeddingModel = openai.embedding('text-embedding-3-small');
