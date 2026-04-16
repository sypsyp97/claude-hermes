import { describe, expect, test } from "bun:test";
import type { AgenticMode } from "./config";
import { classifyTask, selectModel } from "./model-router";

describe("classifyTask", () => {
  test("phrase match wins over keyword", () => {
    const modes: AgenticMode[] = [
      { name: "planning", model: "opus", keywords: [], phrases: ["how should i"] },
      { name: "implementation", model: "sonnet", keywords: ["plan"] },
    ];
    const result = classifyTask("how should i plan this?", modes, "implementation");
    expect(result.mode).toBe("planning");
    expect(result.model).toBe("opus");
    expect(result.confidence).toBe(0.95);
    expect(result.reasoning).toContain("how should i");
  });

  test("keyword-only match scores above confidence floor", () => {
    const modes: AgenticMode[] = [
      { name: "planning", model: "opus", keywords: ["design"] },
      { name: "implementation", model: "sonnet", keywords: ["code"] },
    ];
    const result = classifyTask("design a database schema", modes, "implementation");
    expect(result.mode).toBe("planning");
    expect(result.model).toBe("opus");
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test("tie resolves to defaultMode (implementation)", () => {
    const modes: AgenticMode[] = [
      { name: "planning", model: "opus", keywords: ["write"] },
      { name: "implementation", model: "sonnet", keywords: ["write"] },
    ];
    const result = classifyTask("write a design doc", modes, "implementation");
    expect(result.mode).toBe("implementation");
    expect(result.model).toBe("sonnet");
  });

  test("tie resolves to defaultMode (planning)", () => {
    const modes: AgenticMode[] = [
      { name: "planning", model: "opus", keywords: ["write"] },
      { name: "implementation", model: "sonnet", keywords: ["write"] },
    ];
    const result = classifyTask("write a design doc", modes, "planning");
    expect(result.mode).toBe("planning");
    expect(result.model).toBe("opus");
  });

  test("no match falls back to defaultMode with confidence 0.5", () => {
    const modes: AgenticMode[] = [
      { name: "planning", model: "opus", keywords: ["design"] },
      { name: "implementation", model: "sonnet", keywords: ["code"] },
    ];
    const result = classifyTask("hello world", modes, "implementation");
    expect(result.mode).toBe("implementation");
    expect(result.model).toBe("sonnet");
    expect(result.confidence).toBe(0.5);
    expect(result.reasoning).toContain("Ambiguous");
    expect(result.reasoning).toContain("defaulting to");
    expect(result.reasoning).toContain("implementation");
  });

  test("question marks boost modes that have phrases", () => {
    const modes: AgenticMode[] = [
      {
        name: "planning",
        model: "opus",
        keywords: ["api"],
        phrases: ["how should i"],
      },
      { name: "implementation", model: "sonnet", keywords: ["api"] },
    ];
    const result = classifyTask("api?", modes, "implementation");
    expect(result.mode).toBe("planning");
    expect(result.model).toBe("opus");
  });

  test("case insensitive keyword match", () => {
    const modes: AgenticMode[] = [
      { name: "planning", model: "opus", keywords: ["design"] },
      { name: "implementation", model: "sonnet", keywords: ["code"] },
    ];
    const result = classifyTask("DESIGN", modes, "implementation");
    expect(result.mode).toBe("planning");
    expect(result.model).toBe("opus");
  });
});

describe("selectModel", () => {
  test("returns empty model and unknown taskType for empty modes", () => {
    const result = selectModel("anything", [], "x");
    expect(result).toEqual({
      model: "",
      taskType: "unknown",
      reasoning: "No modes configured",
    });
  });

  test("return shape mirrors classification fields", () => {
    const modes: AgenticMode[] = [
      { name: "planning", model: "opus", keywords: ["design"] },
      { name: "implementation", model: "sonnet", keywords: ["code"] },
    ];
    const result = selectModel("design something", modes, "implementation");
    expect(result.model).toBe("opus");
    expect(result.taskType).toBe("planning");
    expect(typeof result.reasoning).toBe("string");
    expect(result.reasoning.length).toBeGreaterThan(0);
  });
});
