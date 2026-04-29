/**
 * REFLECTION PATTERN EXAMPLE
 *
 * Demonstrates an AI agent that improves its own output through self-critique.
 *
 * HOW IT WORKS:
 * 1. Generate an initial draft
 * 2. Critique the draft (get score + suggestions)
 * 3. If score < threshold: revise based on suggestions
 * 4. Critique again - only keep revision if it improves the score
 * 5. Repeat until quality threshold met or max revisions reached
 *
 * KEY CONCEPTS:
 * - Self-improvement loop with structured feedback
 * - Multiple AI calls orchestrated in sequence
 * - Conditional logic to accept/reject revisions
 * - Using advanced model for critique, basic model for generation
 */

import fs from 'fs/promises';
import { advancedModel, basicModel, basicProviderName, createTemperatureConfig } from '../setup';

import { create, z } from 'casai';

console.log('REFLECTION PATTERN EXAMPLE\nDemonstrates an AI agent that improves its own output through self-critique.\n');

const inputFile = new URL('./input.txt', import.meta.url);

// 1. Define a reusable base configuration using basicModel
const baseLLMConfig = create.Config({
	model: basicModel, //e.g. openai('gpt-4.1-nano');
	...createTemperatureConfig(basicProviderName, 0.7),
	//debug: true,
});

// 2. Define the Agent's Core Capabilities (Renderers)

// 2.1. A renderer to write drafts (inherits the model from baseConfig)
const draftGenerator = create.TextGenerator.withTemplate({
	prompt: 'Write a short, engaging story or blog post about {{ topic }}.',
}, baseLLMConfig);

// 2.2. A renderer to critique drafts using a structured schema.
// This overrides the model to use the advanced model
const critiqueGenerator = create.ObjectGenerator.withTemplate({
	model: advancedModel, // e.g. anthropic('claude-3-7-sonnet-latest')
	output: 'object',
	schema: z.object({
		score: z.number().int().min(1).max(10).describe('Quality score from 1-10 on clarity and engagement.'),
		suggestions: z.array(z.string()).min(1).describe('List of specific, actionable suggestions for improvement.'),
	}),
	prompt: 'Critique this blog post. Provide a quality score and concrete suggestions for improvement.\n\nPOST:\n{{ draft }}',
}, baseLLMConfig);

// A renderer to rewrite a draft based on feedback (inherits GPT-4o)
const revisionGenerator = create.TextGenerator.withTemplate({
	prompt: 'Rewrite the following blog post based on the suggestions provided.\n\nORIGINAL POST:\n{{ draft }}\n\nSUGGESTIONS:\n- {{ suggestions | join("\n- ") }}\n\nREVISED POST:',
}, baseLLMConfig);

// 3. Define the Orchestrator Script
const contentAgent = create.Script({
	context: {
		// Provide the renderers to the script
		draftGenerator,
		critiqueGenerator,
		revisionGenerator,
		// Define workflow parameters
		readTopic: async () => await fs.readFile(inputFile, 'utf-8'),
		qualityThreshold: 8,
		maxRevisions: 3,
	},
	script: // This script orchestrates the agent's "thought process".
		`
    // --- Generate and critique the initial draft ---
    var currentDraft = draftGenerator({ topic: readTopic() }).text
    var critiqueResult = critiqueGenerator({ draft: currentDraft }).object
    var revisionCount = 0

    // --- Revision loop: keep improving until we hit quality threshold or max revisions ---
    while critiqueResult.score < qualityThreshold and revisionCount < maxRevisions
        revisionCount = revisionCount + 1

        // Revise the draft based on current critique
        var revisedDraft = revisionGenerator({
            draft: currentDraft,
            suggestions: critiqueResult.suggestions
        }).text

        // Critique the revised draft
        var newCritique = critiqueGenerator({ draft: revisedDraft }).object

        // Only accept the revision if it's an improvement
        if newCritique.score >= critiqueResult.score
            currentDraft = revisedDraft
            critiqueResult = newCritique
        endif
    endwhile

    // --- Assemble the final result ---
    return {
        finalDraft: currentDraft,
        finalScore: critiqueResult.score,
        revisionsMade: revisionCount
    }`
});

// 4. Run the Agent
const result = await contentAgent();
console.log(JSON.stringify(result, null, 2));
