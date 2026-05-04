/**
 * Test that Samuel's instructions always enforce English, even when
 * memory contains foreign language content (Japanese watches, etc.).
 */

import { describe, it, expect } from "vitest";
import { samuelAgent } from "./samuel";

// Simulate the memory context that gets injected — this is what was
// causing Samuel to speak non-English languages.
const JAPANESE_MEMORY_CONTEXT = [
  "Active watches (you are monitoring these):",
  "Active watches:",
  "- [w_1777351646] N2 level Japanese vocabulary (classifier (LLM judgment), source: audio, cooldown: 30s, fired: 20x)",
].join("\n");

const MIXED_MEMORY = [
  "proficiency:Japanese:intermediate",
  "User corrections (FOLLOW THESE): speak quieter; don't repeat greetings",
  "\n\nActive watches (you are monitoring these):",
  "Active watches:",
  "- [w_1777351646] N2 level Japanese vocabulary (classifier (LLM judgment), source: audio, cooldown: 30s, fired: 20x)",
].join("\n");

function buildInstructions(memoryCtx: string): string {
  let instructions = samuelAgent.instructions as string;
  if (memoryCtx && memoryCtx !== "No prior context.") {
    instructions += `\n\n# Persistent Memory (from previous sessions)\n${memoryCtx}\nFollow these memories strictly. Do not repeat vocabulary marked as known.\nIMPORTANT: Regardless of any language content in memory above, you MUST speak in ENGLISH unless the user explicitly asks otherwise.`;
  }
  return instructions;
}

describe("Samuel language enforcement", () => {
  it("base instructions start with English rule", () => {
    const instructions = samuelAgent.instructions as string;
    expect(instructions).toMatch(/^# ABSOLUTE RULE: ALWAYS SPEAK ENGLISH/);
  });

  it("base instructions contain English rule in critical rules section", () => {
    const instructions = samuelAgent.instructions as string;
    expect(instructions).toContain("You MUST ALWAYS speak and respond in ENGLISH");
  });

  it("English rule appears before any personality or tool instructions", () => {
    const instructions = samuelAgent.instructions as string;
    const englishRulePos = instructions.indexOf("ALWAYS SPEAK ENGLISH");
    const personalityPos = instructions.indexOf("# Personality and Tone");
    expect(englishRulePos).toBeLessThan(personalityPos);
    expect(englishRulePos).toBeGreaterThanOrEqual(0);
  });

  it("injected memory with Japanese watches still has English enforcement after it", () => {
    const full = buildInstructions(JAPANESE_MEMORY_CONTEXT);
    const memoryPos = full.indexOf("N2 level Japanese vocabulary");
    const enforcementPos = full.indexOf("you MUST speak in ENGLISH unless the user explicitly asks");
    expect(memoryPos).toBeGreaterThan(0);
    expect(enforcementPos).toBeGreaterThan(memoryPos);
  });

  it("injected memory with mixed content ends with English enforcement", () => {
    const full = buildInstructions(MIXED_MEMORY);
    const lastEnglishRule = full.lastIndexOf("MUST speak in ENGLISH");
    const memorySection = full.lastIndexOf("# Persistent Memory");
    expect(lastEnglishRule).toBeGreaterThan(memorySection);
  });

  it("English rule count: at least 3 mentions across full instructions", () => {
    const full = buildInstructions(JAPANESE_MEMORY_CONTEXT);
    const matches = full.match(/ENGLISH/gi) || [];
    // Should have: (1) ABSOLUTE RULE header, (2) first-line explanation,
    // (3) Critical Rules section, (4) post-memory enforcement
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("instructions never contain 'respond in Japanese/Spanish/Chinese' etc.", () => {
    const full = buildInstructions(MIXED_MEMORY);
    expect(full).not.toMatch(/respond in (Japanese|Spanish|Chinese|Korean|French|German)/i);
    expect(full).not.toMatch(/speak (Japanese|Spanish|Chinese|Korean|French|German) by default/i);
  });

  it("voice is set to ash on main agent", () => {
    // The voice property should be explicitly set
    expect((samuelAgent as any).voice).toBe("ash");
  });
});
