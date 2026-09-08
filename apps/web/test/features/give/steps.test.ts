import {
  GIVE_STEP_NAMES,
  GIVE_STEP_PATHS,
  giveStepIndex,
  previousGiveStep,
} from "@/features/give/steps";

describe("previousGiveStep", () => {
  it("names the step before each step past the first", () => {
    expect(previousGiveStep("/give/story")).toBe("/give");
    expect(previousGiveStep("/give/details")).toBe("/give/story");
    expect(previousGiveStep("/give/email")).toBe("/give/details");
    expect(previousGiveStep("/give/review")).toBe("/give/email");
  });

  // The regression this table exists to prevent: "← Back" used to leave the
  // flow from every step. Only the first step has nowhere earlier to go.
  it("is null on the first step, where back can only mean leaving the flow", () => {
    expect(previousGiveStep("/give")).toBeNull();
  });

  it("is null on a path that is not a step at all", () => {
    expect(previousGiveStep("/")).toBeNull();
    expect(previousGiveStep("/give/nowhere")).toBeNull();
  });

  it("has a spoken name for every step it can point at", () => {
    for (const path of GIVE_STEP_PATHS) expect(GIVE_STEP_NAMES[path]).toMatch(/^[a-z]+$/);
  });
});

describe("giveStepIndex", () => {
  it("counts the steps in order and treats an unknown path as the first", () => {
    expect(GIVE_STEP_PATHS.map(giveStepIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(giveStepIndex("/give/nowhere")).toBe(0);
  });
});
