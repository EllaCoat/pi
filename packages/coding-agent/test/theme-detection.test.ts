import { describe, expect, it } from "vitest";
import { getAvailableThemes, getThemeByName } from "../src/modes/interactive/theme/theme.ts";

describe("built-in themes", () => {
	it("exposes axia through the normal theme lookup", () => {
		expect(getAvailableThemes()).toContain("axia");
		const axia = getThemeByName("axia");
		expect(axia?.name).toBe("axia");
		expect(axia?.appearance).toBe("dark");
	});
});
