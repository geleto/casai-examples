/**
 * ROUTING PATTERN EXAMPLE
 *
 * Demonstrates routing different types of inputs to specialized handlers.
 *
 * HOW IT WORKS:
 * 1. Classify: Determine the category of the customer inquiry
 * 2. Route: Send to the appropriate specialized handler
 * 3. Process: Each handler is optimized for its specific type
 * 4. Respond: Return tailored response
 *
 * KEY CONCEPTS:
 * - Input classification before processing
 * - Specialized handlers for different categories
 * - Conditional branching (switch/if-else)
 * - Different models/configs per handler type
 * - Efficient resource usage (right tool for the job)
 */

import fs from 'fs/promises';
import { basicModel, advancedModel, providerOptions } from '../setup';
import { create } from 'casai';

console.log('ROUTING PATTERN EXAMPLE\nDemonstrates routing different types of inputs to specialized handlers.\n');

const inputFile = new URL('./input.txt', import.meta.url);

// 1. Define configurations for different handler types
const quickResponseConfig = create.Config({
	model: basicModel,
	providerOptions,
});

const detailedResponseConfig = create.Config({
	model: advancedModel,
	providerOptions,
});

// 2. Define the classifier using enum output for efficient routing
const inquiryClassifier = create.ObjectGenerator.withTemplate({
	output: 'enum',
	enum: ['technical', 'billing', 'general', 'urgent'],
	prompt: 'Classify this customer inquiry into one of these categories:\n\nINQUIRY:\n{{ inquiry }}\n\nCategories:\n- technical: API issues, integration problems, technical errors\n- billing: Payments, invoices, subscription questions\n- general: Product questions, feature requests, general support\n- urgent: Service outages, critical bugs, security issues\n\nReturn only the category name.',
}, quickResponseConfig);

// 3. Define specialized handlers for each category

// Technical support handler - detailed and precise
const technicalHandler = create.TextGenerator.withTemplate({
	prompt: 'Provide a detailed technical support response to this inquiry:\n\n{{ inquiry }}\n\nInclude:\n- Clear diagnosis of the issue\n- Step-by-step solution\n- Relevant documentation links\n- Follow-up recommendations',
}, detailedResponseConfig);

// Billing handler - empathetic and solution-focused
const billingHandler = create.TextGenerator.withTemplate({
	prompt: 'Provide a professional billing support response to this inquiry:\n\n{{ inquiry }}\n\nBe:\n- Empathetic and understanding\n- Clear about billing policies\n- Solution-oriented\n- Offer specific next steps',
}, detailedResponseConfig);

// General support handler - friendly and informative
const generalHandler = create.TextGenerator.withTemplate({
	prompt: 'Provide a helpful general support response to this inquiry:\n\n{{ inquiry }}\n\nBe:\n- Friendly and approachable\n- Informative and clear\n- Proactive in offering additional help',
}, quickResponseConfig);

// Urgent handler - immediate and action-oriented
const urgentHandler = create.TextGenerator.withTemplate({
	prompt: 'Provide an immediate response to this urgent inquiry:\n\n{{ inquiry }}\n\nPrioritize:\n- Acknowledgment of urgency\n- Immediate action items\n- Escalation path if needed\n- Expected resolution timeline',
}, detailedResponseConfig);

// 4. Create the routing script
const supportAgent = create.Script({
	context: {
		inquiryClassifier,
		handlers: {
			technical: technicalHandler,
			billing: billingHandler,
			general: generalHandler,
			urgent: urgentHandler,
		},
		readInquiry: async () => {
			const inquiry = await fs.readFile(inputFile, 'utf-8')
			return inquiry.trim()
		}
	},
	script: `
		// Step 1: Read and classify the inquiry
		var inquiry = readInquiry()
		var category = inquiryClassifier({ inquiry: inquiry }).object

		// Step 2: Route to appropriate handler based on classification
		var response
		var handler = handlers[category]
		if handler
			response = handler({ inquiry: inquiry }).text
		else
			response = handlers.general({ inquiry: inquiry }).text
		endif

		// Step 3: Assemble the result with metadata
		return {
			category: category,
			response: response,
			originalInquiry: inquiry
		}
	`
});

// 5. Run the routing agent
const result = await supportAgent();
console.log(JSON.stringify(result, null, 2));
