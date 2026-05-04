import { readConfigInternal } from "./config.js";

export async function callOpenai(
	apiKey: string,
	model: string,
	system: string,
	user: string,
	temp: number,
	maxTokens: number,
): Promise<string> {
	const body = {
		model,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		temperature: temp,
		max_tokens: maxTokens,
	};

	return callOpenaiRaw(apiKey, body);
}

export async function callOpenaiReasoning(
	apiKey: string,
	model: string,
	system: string,
	user: string,
	reasoningEffort: string,
	maxOutputTokens: number,
): Promise<string> {
	const body = {
		model,
		input: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		reasoning: { effort: reasoningEffort },
		max_output_tokens: maxOutputTokens,
	};

	try {
		const resp = await fetch("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		if (!resp.ok) {
			const errText = await resp.text();
			console.error(`[plugins] reasoning API error: ${errText}`);
			return callOpenai(apiKey, model, system, user, 0.2, maxOutputTokens);
		}

		const data = await resp.json();

		// Responses API returns output[] array with message items
		if (Array.isArray(data.output)) {
			for (const item of data.output) {
				if (item.type === "message" && Array.isArray(item.content)) {
					for (const c of item.content) {
						if (c.type === "output_text" && typeof c.text === "string") {
							return c.text.trim();
						}
					}
				}
			}
		}

		// Fallback: try chat completions format
		const fallback = data?.choices?.[0]?.message?.content;
		if (typeof fallback === "string") {
			return fallback.trim();
		}

		throw new Error("No content in reasoning response");
	} catch (err) {
		if (err instanceof Error && err.message === "No content in reasoning response") {
			throw err;
		}
		// Network or parse error — fall back to chat completions
		return callOpenai(apiKey, model, system, user, 0.2, maxOutputTokens);
	}
}

export async function callOpenaiRaw(apiKey: string, body: Record<string, unknown>): Promise<string> {
	const resp = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		const errText = await resp.text();
		throw new Error(`LLM call failed: ${errText}`);
	}

	const data = await resp.json();
	const content = data?.choices?.[0]?.message?.content;
	if (typeof content !== "string") {
		throw new Error("No content in LLM response");
	}
	return content.trim();
}

export function stripFences(code: string): string {
	let s = code;
	for (const prefix of ["```javascript", "```js", "```json", "```"]) {
		if (s.startsWith(prefix)) {
			s = s.slice(prefix.length);
			break;
		}
	}
	if (s.endsWith("```")) {
		s = s.slice(0, -3);
	}
	return s.trim();
}

export async function getApiKey(): Promise<string> {
	const config = readConfigInternal();
	if (!config.apiKey) {
		throw new Error("No API key configured");
	}
	return config.apiKey;
}
