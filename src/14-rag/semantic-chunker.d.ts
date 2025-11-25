/**
 * This file is required because the 'semantic-chunker' package has a bug in its package.json exports.
 * It does not correctly expose its type definitions for modern TypeScript environments (moduleResolution: bundler/node16).
 *
 * Until the library fixes its package.json to include "types" in the "exports" field, we need this local declaration
 * to provide type safety and avoid implicit 'any' errors.
 *
 * I will switch to a different chunker later.
 */

// Types matching the package's types/types.d.ts
// with 'split' made optional in semantic() to match actual usage
type Embedding = number[];
type EmbedFunction<Input = string> = (input: Input) => Promise<Embedding>;
type Chunker<Input = string, Output = [string, Embedding]> = (
	input: Input,
	...rest: any[]
) => AsyncGenerator<Output>;

declare module 'semantic-chunker' {
	export function full({
		embed,
	}: {
		embed: EmbedFunction;
	}): Chunker;

	export function sentence({
		embed,
		split,
	}: {
		embed: EmbedFunction;
		split: number;
	}): Chunker;

	export function semantic({
		embed,
		split,
		zScoreThreshold,
	}: {
		embed: EmbedFunction;
		split?: number; // Made optional to match actual usage
		zScoreThreshold: number;
	}): Chunker;

	export default semantic;
}
