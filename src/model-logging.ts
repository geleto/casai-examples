/**
 * Optional model-call observability.
 *
 * This file wraps language models only to print progress and aggregate stats
 * such as timing, token usage, active calls, and max concurrency. It does not
 * change prompts, model parameters, results, retries, or execution behavior.
 */

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

export interface ModelPricing {
	inputUsdPerMillion: number;
	cachedInputUsdPerMillion?: number;
	cacheWriteUsdPerMillion?: number;
	outputUsdPerMillion: number;
}

interface ModelCallStats {
	started: number;
	completed: number;
	failed: number;
	active: number;
	maxActive: number;
	totalDurationMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	pricing?: ModelPricing;
}

const modelStats = new Map<string, ModelCallStats>();
let totalActiveCalls = 0;
let maxTotalActiveCalls = 0;
let activePeriodStartTime: number | undefined;
let totalActiveDurationMs = 0;
let summaryLoggerRegistered = false;
let summaryPrinted = false;

function getModelStats(modelName: string, pricing?: ModelPricing): ModelCallStats {
	let stats = modelStats.get(modelName);
	if (!stats) {
		stats = {
			started: 0,
			completed: 0,
			failed: 0,
			active: 0,
			maxActive: 0,
			totalDurationMs: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			pricing,
		};
		modelStats.set(modelName, stats);
	} else if (pricing && !stats.pricing) {
		stats.pricing = pricing;
	}
	return stats;
}

function getTokenCount(val: unknown): number {
	if (typeof val === 'number') return val;
	if (typeof val === 'object' && val !== null && 'total' in val) {
		const total = (val as { total?: number | undefined }).total;
		return typeof total === 'number' ? total : 0;
	}
	return 0;
}

function getUsageCounts(usage: LanguageModelV3Usage | undefined) {
	const inputTokens = getTokenCount(usage?.inputTokens);
	const outputTokens = getTokenCount(usage?.outputTokens);
	const cacheReadTokens = usage?.inputTokens.cacheRead ?? 0;
	const cacheWriteTokens = usage?.inputTokens.cacheWrite ?? 0;
	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function formatTokenUsage(inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) {
	const totalTokens = inputTokens + outputTokens;
	const cacheSuffix = cacheReadTokens || cacheWriteTokens
		? `, ${cacheReadTokens.toLocaleString()} cache read + ${cacheWriteTokens.toLocaleString()} cache write`
		: '';
	return `${totalTokens.toLocaleString()} tokens (${inputTokens.toLocaleString()} in + ${outputTokens.toLocaleString()} out${cacheSuffix})`;
}

function estimateCostUsd(pricing: ModelPricing | undefined, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) {
	if (!pricing) return undefined;

	const uncachedInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
	const cacheReadRate = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
	const cacheWriteRate = pricing.cacheWriteUsdPerMillion ?? pricing.inputUsdPerMillion;
	return (
		(uncachedInputTokens * pricing.inputUsdPerMillion
			+ cacheReadTokens * cacheReadRate
			+ cacheWriteTokens * cacheWriteRate
			+ outputTokens * pricing.outputUsdPerMillion) / 1_000_000
	);
}

function formatCostUsd(costUsd: number | undefined) {
	if (costUsd === undefined) return '';
	return `, est. cost ${formatCostAmount(costUsd)}`;
}

function formatCostAmount(costUsd: number | undefined) {
	if (costUsd === undefined) return 'unavailable';
	return `$${costUsd.toFixed(costUsd < 1 ? 4 : 2)}`;
}

function sumCosts(costs: Array<number | undefined>) {
	return costs.every(cost => cost !== undefined)
		? costs.reduce((total, cost) => total + cost, 0)
		: undefined;
}

function formatSeconds(ms: number) {
	return `${(ms / 1000).toFixed(2)}s`;
}

function recordModelUsage(modelName: string, usage: LanguageModelV3Usage | undefined) {
	const stats = getModelStats(modelName);
	const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = getUsageCounts(usage);
	stats.inputTokens += inputTokens;
	stats.outputTokens += outputTokens;
	stats.cacheReadTokens += cacheReadTokens;
	stats.cacheWriteTokens += cacheWriteTokens;
}

function printModelStatsSummary() {
	if (summaryPrinted || modelStats.size === 0) {
		return;
	}

	summaryPrinted = true;
	const statsEntries = Array.from(modelStats.entries());
	const totalInputTokens = statsEntries.reduce((total, [, stats]) => total + stats.inputTokens, 0);
	const totalOutputTokens = statsEntries.reduce((total, [, stats]) => total + stats.outputTokens, 0);
	const totalCacheReadTokens = statsEntries.reduce((total, [, stats]) => total + stats.cacheReadTokens, 0);
	const totalCacheWriteTokens = statsEntries.reduce((total, [, stats]) => total + stats.cacheWriteTokens, 0);
	const totalDurationMs = statsEntries.reduce((total, [, stats]) => total + stats.totalDurationMs, 0);
	const totalCostUsd = sumCosts(statsEntries.map(([, stats]) =>
		estimateCostUsd(stats.pricing, stats.inputTokens, stats.outputTokens, stats.cacheReadTokens, stats.cacheWriteTokens)
	));
	const activeDurationMs = totalActiveDurationMs + (activePeriodStartTime ? Date.now() - activePeriodStartTime : 0);
	const averageConcurrency = activeDurationMs > 0 ? totalDurationMs / activeDurationMs : 0;

	process.stdout.write(`------\n[LLM] Max concurrent calls: ${maxTotalActiveCalls} total\n`);
	process.stdout.write(
		`[LLM] LLM concurrency speedup: ${averageConcurrency.toFixed(2)}x (${formatSeconds(totalDurationMs)} summed call time / ${formatSeconds(activeDurationMs)} active elapsed)\n`
	);

	statsEntries.forEach(([name, stats]) => {
		const costUsd = estimateCostUsd(stats.pricing, stats.inputTokens, stats.outputTokens, stats.cacheReadTokens, stats.cacheWriteTokens);
		process.stdout.write(
			`[LLM] ${name}: max ${stats.maxActive}, calls ${stats.started}, time ${formatSeconds(stats.totalDurationMs)}, tokens ${formatTokenUsage(stats.inputTokens, stats.outputTokens, stats.cacheReadTokens, stats.cacheWriteTokens)}${formatCostUsd(costUsd)}\n`
		);
	});

	process.stdout.write(`[LLM] Total tokens: ${formatTokenUsage(totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens)}\n`);
	process.stdout.write(`[LLM] Estimated total cost: ${formatCostAmount(totalCostUsd)}\n`);
}

function registerSummaryLogger() {
	if (summaryLoggerRegistered) {
		return;
	}

	summaryLoggerRegistered = true;
	process.once('beforeExit', printModelStatsSummary);
	process.once('exit', printModelStatsSummary);
}

function startModelCall(modelName: string, pricing?: ModelPricing): number {
	registerSummaryLogger();

	if (totalActiveCalls === 0) {
		activePeriodStartTime = Date.now();
	}

	const stats = getModelStats(modelName, pricing);
	stats.started++;
	stats.active++;
	stats.maxActive = Math.max(stats.maxActive, stats.active);

	totalActiveCalls++;
	maxTotalActiveCalls = Math.max(maxTotalActiveCalls, totalActiveCalls);

	return stats.active;
}

function finishModelCall(modelName: string, failed = false, durationMs = 0): number {
	const stats = getModelStats(modelName);
	const now = Date.now();
	stats.totalDurationMs += durationMs;

	if (stats.active > 0) {
		stats.active--;
	}
	if (totalActiveCalls > 0) {
		totalActiveCalls--;
	}
	if (totalActiveCalls === 0 && activePeriodStartTime) {
		totalActiveDurationMs += now - activePeriodStartTime;
		activePeriodStartTime = undefined;
	}

	if (failed) {
		stats.failed++;
	} else {
		stats.completed++;
	}

	return stats.active;
}

function getActiveAfterCurrentCall(modelName: string): number {
	return Math.max((modelStats.get(modelName)?.active ?? 1) - 1, 0);
}

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

	const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = getUsageCounts(usage);
	const tokenInfo = formatTokenUsage(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
	const costInfo = formatCostUsd(estimateCostUsd(getModelStats(modelName).pricing, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens));

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
		`[${modelName} #${callId}] ✅ Complete ${mode}: ${tokenInfo}${costInfo} in ${duration}s | active: ${activeCalls}${finishInfo}${resultSuffix}\n`
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
	showProgress = true,
	pricing?: ModelPricing
) {
	if (!showProgress) {
		return model;
	}

	let callCounter = 0;

	return wrapLanguageModel({
		model,
		middleware: {
			specificationVersion: 'v3',
			wrapGenerate: async ({ doGenerate, params }) => {
				const callId = ++callCounter;
				const startTime = Date.now();
				const promptSuffix = formatPromptSuffix(getPromptPreview(params));

				const activeCalls = startModelCall(modelName, pricing);
				process.stdout.write(
					`[${modelName} #${callId}] 🚩 Start generating${promptSuffix} | active: ${activeCalls}\n`
				);

				let callFinished = false;
				try {
					const result = await doGenerate();
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
					recordModelUsage(modelName, result.usage);
					const durationMs = Date.now() - startTime;
					const activeCallsAfterFinish = finishModelCall(modelName, false, durationMs);
					callFinished = true;

					logCompletion(
						modelName,
						callId,
						startTime,
						result.usage,
						'generating',
						activeCallsAfterFinish,
						text
					);

					return result;
				} catch (error) {
					if (!callFinished) {
						const durationMs = Date.now() - startTime;
						finishModelCall(modelName, true, durationMs);
					}
					throw error;
				}
			},

			wrapStream: async ({ doStream, params }) => {
				const callId = ++callCounter;
				const startTime = Date.now();
				const promptSuffix = formatPromptSuffix(getPromptPreview(params));

				const activeCalls = startModelCall(modelName, pricing);
				process.stdout.write(
					`[${modelName} #${callId}] 🚩 Start streaming${promptSuffix} | active: ${activeCalls}\n`
				);

				let streamResult;
				try {
					streamResult = await doStream();
				} catch (error) {
					const durationMs = Date.now() - startTime;
					finishModelCall(modelName, true, durationMs);
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
				let callEnded = false;

				const endStreamCall = (failed = false) => {
					if (callEnded) {
						return getModelStats(modelName).active;
					}

					callEnded = true;
					const durationMs = Date.now() - startTime;
					const activeCalls = finishModelCall(modelName, failed, durationMs);
					return activeCalls;
				};

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
									getActiveAfterCurrentCall(modelName),
									logText,
									finishReason
								);
								recordModelUsage(modelName, chunk.usage);

								// Cleanup maps
								toolInputs.clear();
								toolCallIds.clear();
								loggedToolCalls.clear();
							}
						} catch (error) {
							endStreamCall(true);
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
							const activeCalls = endStreamCall(true);
							process.stdout.write(
								`[${modelName} #${callId}] ⚠️  Stream ended without finish chunk | active: ${activeCalls}\n`
							);
						} else {
							// Normal finish already decremented
							endStreamCall();
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
