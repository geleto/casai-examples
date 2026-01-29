import { wrapLanguageModel } from 'ai';
import {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3FinishReason,
	LanguageModelV3StreamPart,
	LanguageModelV3Usage
} from '@ai-sdk/provider';

/**
 * Model Logging Utility (Optional)
 *
 * This module provides optional logging functionality for language models. It wraps
 * any LanguageModelV3 instance using the AI SDK's `wrapLanguageModel` middleware
 * to intercept and log model calls without modifying the underlying model behavior.
 *
 * Key Features:
 * - Logs generation and streaming calls with timing, token usage, and active call counts
 * - Displays prompt previews, tool calls with arguments, and tool results
 * - Tracks reasoning steps for models that support it (e.g., o1 models)
 * - Completely optional - can be disabled by passing `showProgress: false`
 *
 * Usage - see setup.ts
 * The wrapper intercepts calls at the middleware level, logging all interactions
 * while preserving the original model's behavior and return values.
 */

const PREVIEW_LIMIT = 40;
const TOOL_RESULT_PREVIEW_LIMIT = 100;

// Helper function to extract and format tool arguments
function getToolArguments(part: { type: string;[key: string]: unknown }): string {
	try {
		// Check for both 'args' and 'input' properties
		const args = 'args' in part
			? part.args
			: ('input' in part ? (part as unknown as { input: unknown }).input : undefined);

		if (!args) {
			return '';
		}

		// If args is already a string, use it directly; otherwise stringify
		return typeof args === 'string' ? args : JSON.stringify(args);
	} catch {
		return '[stringify error]';
	}
}

// Helper function to format tool results
function formatToolResult(result: unknown): string {
	try {
		const resultStr = typeof result === 'string'
			? result
			: JSON.stringify(result);
		return resultStr.length > TOOL_RESULT_PREVIEW_LIMIT
			? resultStr.substring(0, TOOL_RESULT_PREVIEW_LIMIT) + '...'
			: resultStr;
	} catch {
		return '[stringify error]';
	}
}

// Helper function for completion logging
function logCompletion(
	modelName: string,
	callId: number,
	startTime: number,
	usage: LanguageModelV3Usage | undefined,
	mode: 'generating' | 'streaming',
	activeCalls: number,
	text: string | undefined,
	finishReason?: LanguageModelV3FinishReason | string
) {
	const duration = ((Date.now() - startTime) / 1000).toFixed(2);

	// Show input/output tokens for better visibility
	// Handle both number and object formats (some providers return structured usage)
	const getCount = (val: unknown): number => {
		if (typeof val === 'number') return val;
		if (typeof val === 'object' && val !== null && 'total' in val) {
			const total = (val as { total?: number | undefined }).total;
			return typeof total === 'number' ? total : 0;
		}
		return 0;
	};

	const inputTokens = getCount(usage?.inputTokens);
	const outputTokens = getCount(usage?.outputTokens);
	const totalTokens = inputTokens + outputTokens;

	const tokenInfo = inputTokens > 0
		? `${totalTokens} tokens (${inputTokens} in + ${outputTokens} out)`
		: `${outputTokens} tokens`;

	let resultSuffix = '';
	if (text) {
		const preview = text.trim().replace(/\s+/g, ' ');
		const truncated =
			preview.length > PREVIEW_LIMIT ? `${preview.slice(0, PREVIEW_LIMIT)}...` : preview;
		resultSuffix = ` | result: "${truncated.replace(/"/g, '\\"')}"`;
	}

	let finishInfo = '';
	if (finishReason) {
		if (typeof finishReason === 'string') {
			finishInfo = ` | reason: ${finishReason}`;
		} else {
			const rawSuffix = finishReason.raw ? ` (${finishReason.raw})` : '';
			finishInfo = ` | reason: ${finishReason.unified}${rawSuffix}`;
		}
	}

	process.stdout.write(
		`[${modelName} #${callId}] ✅ Complete ${mode}: ${tokenInfo} in ${duration}s | active: ${activeCalls}${finishInfo}${resultSuffix}\n`
	);
}

interface PromptPreview {
	text: string;
	truncated: boolean;
}

function getPromptPreview(params: LanguageModelV3CallOptions | undefined): PromptPreview | undefined {
	if (!params) {
		return undefined;
	}

	const prompt = params.prompt;
	if (!Array.isArray(prompt)) {
		return undefined;
	}

	let preview = '';
	let truncated = false;

	const appendText = (text: string) => {
		if (preview.length >= PREVIEW_LIMIT) {
			truncated = true;
			return;
		}

		const sanitized = text.replace(/\s+/g, ' ').trim();
		if (!sanitized) {
			return;
		}

		const segment = preview.length > 0 ? ` ${sanitized}` : sanitized;
		if (!segment) {
			return;
		}

		const remaining = PREVIEW_LIMIT - preview.length;
		if (segment.length > remaining) {
			truncated = true;
		}

		preview += segment.slice(0, remaining);
	};

	for (const message of prompt) {
		if (preview.length >= PREVIEW_LIMIT) {
			truncated = true;
			break;
		}

		if (message.role === 'system') {
			appendText(message.content);
			continue;
		}

		if (!Array.isArray(message.content)) {
			continue;
		}

		for (const part of message.content) {
			if (preview.length >= PREVIEW_LIMIT) {
				truncated = true;
				break;
			}

			if (part.type === 'text') {
				appendText(part.text);
			} else if (part.type === 'reasoning') {
				appendText(part.text);
			}

			if (preview.length >= PREVIEW_LIMIT) {
				truncated = true;
				break;
			}
		}
	}

	if (!preview) {
		return undefined;
	}

	return {
		text: preview,
		truncated
	};
}

function formatPromptSuffix(preview: PromptPreview | undefined) {
	if (!preview) {
		return '';
	}

	const escaped = preview.text.replace(/"/g, '\\"');
	const display = preview.truncated ? `${escaped}...` : escaped;

	return ` | prompt: "${display}"`;
}

// Progress indicator wrapper
export function withProgressIndicator(
	model: LanguageModelV3,
	modelName: string,
	showProgress = true
) {
	if (!showProgress) {
		return model;
	}

	let callCounter = 0;
	let activeCalls = 0;

	return wrapLanguageModel({
		model,
		middleware: {
			specificationVersion: 'v3',
			wrapGenerate: async ({ doGenerate, params }) => {
				const callId = ++callCounter;
				const startTime = Date.now();
				const promptSuffix = formatPromptSuffix(getPromptPreview(params));

				activeCalls++;
				process.stdout.write(
					`[${modelName} #${callId}] 🚩 Start generating${promptSuffix} | active: ${activeCalls}\n`
				);

				try {
					const result = await doGenerate();
					activeCalls--;

					const textParts: string[] = [];
					const toolCallMap = new Map<string, string>();

					result.content.forEach(part => {
						if (part.type === 'text') {
							textParts.push(part.text);
						} else if (part.type === 'tool-call') {
							textParts.push(`tool:${part.toolName}`);

							// Store tool call ID for matching with results
							const toolCallId = part.toolCallId;
							if (toolCallId) {
								toolCallMap.set(toolCallId, part.toolName);
							}

							// Log tool call with arguments using helper
							const argsStr = getToolArguments(part);
							process.stdout.write(
								`[${modelName} #${callId}] 🔧 ${part.toolName}(${argsStr})\n`
							);
						} else if (part.type === 'tool-result') {
							const toolName = part.toolCallId ? toolCallMap.get(part.toolCallId) ?? 'unknown' : 'unknown';

							// Log tool result with different emoji
							const resultStr = formatToolResult(part.result);
							process.stdout.write(
								`[${modelName} #${callId}] 📥 ${toolName} → ${resultStr}\n`
							);
						}
					});

					const text = textParts.join(', ');

					logCompletion(
						modelName,
						callId,
						startTime,
						result.usage,
						'generating',
						activeCalls,
						text
					);

					return result;
				} catch (error) {
					activeCalls--;
					throw error;
				}
			},

			wrapStream: async ({ doStream, params }) => {
				const callId = ++callCounter;
				const startTime = Date.now();
				const promptSuffix = formatPromptSuffix(getPromptPreview(params));

				activeCalls++;
				process.stdout.write(
					`[${modelName} #${callId}] 🚩 Start streaming${promptSuffix} | active: ${activeCalls}\n`
				);

				let streamResult;
				try {
					streamResult = await doStream();
				} catch (error) {
					activeCalls--;
					throw error;
				}

				const { stream: originalStream, ...rest } = streamResult;

				let fullText = '';
				let reasoningText = '';
				const toolInputs = new Map<string, string>();
				const toolCallIds = new Map<string, string>();
				const loggedToolCalls = new Set<string>();
				let streamFinished = false;
				let finishReason: LanguageModelV3FinishReason | string | undefined;

				const transformStream = new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
					transform(chunk: LanguageModelV3StreamPart, controller) {
						try {
							if (chunk.type === 'text-delta') {
								fullText += chunk.delta;
							} else if (chunk.type === 'reasoning-start') {
								// Log reasoning start for o1 models
								process.stdout.write(
									`[${modelName} #${callId}] 🧠 Reasoning...\n`
								);
							} else if (chunk.type === 'reasoning-delta') {
								reasoningText += chunk.delta;
							} else if (chunk.type === 'reasoning-end') {
								// Show brief reasoning summary
								const preview = reasoningText.trim().replace(/\s+/g, ' ');
								const truncated = preview.length > PREVIEW_LIMIT
									? `${preview.slice(0, PREVIEW_LIMIT)}...`
									: preview;
								process.stdout.write(
									`[${modelName} #${callId}] 🧠 Reasoning complete: "${truncated}"\n`
								);
							} else if (chunk.type === 'tool-call') {
								// Store tool call ID for matching with results
								const toolCallId = chunk.toolCallId;
								if (toolCallId) {
									toolCallIds.set(toolCallId, chunk.toolName);
								}

								const callKey = toolCallId ? `${chunk.toolName}-${toolCallId}` : `${chunk.toolName}-default`;
								if (!loggedToolCalls.has(callKey)) {
									loggedToolCalls.add(callKey);

									// Log tool call with arguments using helper
									const argsStr = getToolArguments(chunk);
									process.stdout.write(
										`[${modelName} #${callId}] 🔧 ${chunk.toolName}(${argsStr})\n`
									);
								}
							} else if (chunk.type === 'tool-input-start') {
								toolCallIds.set(chunk.id, chunk.toolName);
								toolInputs.set(chunk.id, '');
							} else if (chunk.type === 'tool-input-delta') {
								const currentInput = toolInputs.get(chunk.id) ?? '';
								toolInputs.set(chunk.id, currentInput + chunk.delta);
							} else if (chunk.type === 'tool-input-end') {
								const toolName = toolCallIds.get(chunk.id);
								if (toolName) {
									const callKey = `${toolName}-${chunk.id}`;
									if (!loggedToolCalls.has(callKey)) {
										loggedToolCalls.add(callKey);
										const input = toolInputs.get(chunk.id);
										process.stdout.write(
											`[${modelName} #${callId}] 🔧 ${toolName}(${input ?? ''})\n`
										);
									}
									// Clean up input but keep toolCallIds for matching results
									toolInputs.delete(chunk.id);
								}
							} else if (chunk.type === 'tool-result') {
								const toolName = toolCallIds.get(chunk.toolCallId) ?? 'unknown';

								// Log tool result with different emoji
								const resultStr = formatToolResult(chunk.result);
								process.stdout.write(
									`[${modelName} #${callId}] 📥 ${toolName} → ${resultStr}\n`
								);
							} else if (chunk.type === 'error') {
								// Log errors from the model
								const errorMsg = 'error' in chunk ? String(chunk.error) : 'unknown error';
								process.stdout.write(
									`[${modelName} #${callId}] ❌ Model error: ${errorMsg}\n`
								);
							}

							controller.enqueue(chunk);

							if (chunk.type === 'finish') {
								streamFinished = true;
								finishReason = chunk.finishReason;

								// Build tool list from loggedToolCalls
								const uniqueTools = new Set<string>();
								loggedToolCalls.forEach(key => {
									const toolName = key.split('-')[0];
									uniqueTools.add(toolName);
								});

								const toolLog = Array.from(uniqueTools)
									.map(name => `tool:${name}`)
									.join(', ');

								let logText = fullText;
								if (fullText && toolLog) {
									logText += `, ${toolLog}`;
								} else if (toolLog) {
									logText = toolLog;
								}

								logCompletion(
									modelName,
									callId,
									startTime,
									chunk.usage,
									'streaming',
									activeCalls - 1, // Show correct count after decrement
									logText,
									finishReason
								);

								// Cleanup maps
								toolInputs.clear();
								toolCallIds.clear();
								loggedToolCalls.clear();
							}
						} catch (error) {
							// Log unexpected errors during chunk processing
							const errorMsg = error instanceof Error ? error.message : 'unknown';
							process.stdout.write(
								`[${modelName} #${callId}] ⚠️  Error processing chunk (${chunk.type}): ${errorMsg}\n`
							);
							// Re-throw to ensure stream error handling works
							throw error;
						}
					},

					flush() {
						// Ensure activeCalls is decremented if stream ends without finish
						if (!streamFinished) {
							activeCalls--;
							process.stdout.write(
								`[${modelName} #${callId}] ⚠️  Stream ended without finish chunk | active: ${activeCalls}\n`
							);
						} else {
							// Normal finish already decremented
							activeCalls--;
						}

						// Cleanup on stream end
						toolInputs.clear();
						toolCallIds.clear();
						loggedToolCalls.clear();
					}
				});

				return {
					stream: originalStream.pipeThrough(transformStream),
					...rest
				};
			}
		}
	});
}
