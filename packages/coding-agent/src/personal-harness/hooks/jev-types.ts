export type JevJsonValue = string | number | boolean | null | JevJsonValue[] | { [key: string]: JevJsonValue };
export type JevJsonContainer = string | JevJsonValue[] | { [key: string]: JevJsonValue };

export type JevQuestion =
	| { type: "noul"; instructions: JevJsonContainer; criteria?: { true: string; false: string } }
	| { type: "choice"; instructions: JevJsonContainer; criteria: Record<string, string | null> }
	| { type: "score"; instructions: JevJsonContainer; criteria: string[] };

export interface JevEvaluationInput {
	state: JevJsonContainer;
	questions: Record<string, JevQuestion>;
}

export type JevAnswer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| {
			type: "score";
			score: number;
			legend: Record<string, string>;
			confidence: number;
			probabilities?: Record<string, number>;
	  };

export interface JevEvaluationResponse {
	model: string;
	answers: Record<string, JevAnswer>;
	usage: { input_tokens: number; output_tokens: number };
	estimated_input_cost_usd?: number;
}

export type JevEvaluator = (input: JevEvaluationInput, signal: AbortSignal) => Promise<JevEvaluationResponse>;

const MAX_REQUEST_BYTES = 65_536;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertJevRequestSize(input: JevEvaluationInput): void {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify({ state: input.state, model: "jev-latest", questions: input.questions });
	} catch {
		throw new Error("Invalid Jev request");
	}
	if (typeof serialized !== "string") throw new Error("Invalid Jev request");
	if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES)
		throw new Error("Jev request exceeded the size limit");
}
export function validateJevResponse(response: JevEvaluationResponse, input: JevEvaluationInput): void {
	const expected = Object.keys(input.questions);
	const actual = Object.keys(response.answers);
	if (
		!response.model ||
		actual.length !== expected.length ||
		expected.some((key) => !Object.hasOwn(response.answers, key))
	) {
		throw new Error("Invalid Jev response shape");
	}
	if (
		!Number.isSafeInteger(response.usage.input_tokens) ||
		response.usage.input_tokens < 0 ||
		!Number.isSafeInteger(response.usage.output_tokens) ||
		response.usage.output_tokens < 0
	) {
		throw new Error("Invalid Jev usage");
	}
	for (const [key, question] of Object.entries(input.questions)) {
		const answer = response.answers[key];
		if (!answer || answer.type !== question.type) throw new Error("Invalid Jev answer type");
		if (question.type === "choice" && answer.type === "choice") {
			if (
				!Object.hasOwn(question.criteria, answer.choice) ||
				!Number.isFinite(answer.confidence) ||
				answer.confidence < 0 ||
				answer.confidence > 1
			) {
				throw new Error("Invalid Jev choice answer");
			}
			if (
				Object.entries(answer.probabilities).some(
					([choice, probability]) =>
						!Object.hasOwn(question.criteria, choice) ||
						!Number.isFinite(probability) ||
						probability < 0 ||
						probability > 1,
				)
			) {
				throw new Error("Invalid Jev choice probabilities");
			}
		} else if (question.type === "score" && answer.type === "score") {
			if (
				!Number.isFinite(answer.score) ||
				answer.score < 0 ||
				answer.score > question.criteria.length - 1 ||
				!Number.isFinite(answer.confidence) ||
				answer.confidence < 0 ||
				answer.confidence > 1
			) {
				throw new Error("Invalid Jev score answer");
			}
		} else if (
			question.type === "noul" &&
			answer.type === "noul" &&
			(!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
		) {
			throw new Error("Invalid Jev noul answer");
		}
	}
}
