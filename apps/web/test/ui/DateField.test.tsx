/**
 * Issue #133. Two things worth pinning down, both of which a render test can
 * actually fail on:
 *
 * 1. The control really is `<input type="date">`. The whole change is worth
 *    nothing if it renders a text box that merely accepts `YYYY-MM-DD` —
 *    which is exactly what `<TextInput type="date">` would have produced,
 *    since react-native-web overwrites the `type` prop with one it derives
 *    from `inputMode`/`keyboardType`. That failure is invisible in every
 *    other assertion here: the value, the validation and the submitted
 *    payload are identical either way.
 *
 * 2. The picker does not refuse under-age dates. Constraining `max` to
 *    `MINIMUM_AGE` years ago would be the obvious "helpful" thing and would
 *    quietly undo issue #64, which replaced a self-attesting checkbox
 *    precisely so the control stops handing the user its own passing answer.
 */
import * as React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { MINIMUM_AGE } from "@keepsake/contracts/common";
import { AgeGateField } from "@/features/ageGate/AgeGateField";
import { DateField } from "@/ui/DateField";

/** Walks the rendered tree for the one `<input>` and returns its props. Not
 * via `JSON.stringify` — that drops the handlers this needs to read. */
function dateInput(tree: unknown): Record<string, unknown> {
  const found: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const el = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown };
    if (el.type === "input") found.push(el.props ?? {});
    walk(el.children);
  };
  walk(tree);
  if (found.length !== 1) throw new Error(`Expected exactly one <input>, found ${found.length}`);
  return found[0] as Record<string, unknown>;
}

describe("DateField (web)", () => {
  it("renders a native date picker, not a text box", () => {
    const { toJSON } = render(<DateField label="Date of birth" value="1990-01-01" onChangeText={jest.fn()} />);
    expect(dateInput(toJSON()).type).toBe("date");
  });

  it("reports the picked value as the YYYY-MM-DD string the schema validates", () => {
    const onChangeText = jest.fn();
    const { getByLabelText } = render(<DateField label="Date of birth" value="" onChangeText={onChangeText} />);
    fireEvent.changeText(getByLabelText("Date of birth"), "1974-03-08");
    expect(onChangeText).toHaveBeenCalledWith("1974-03-08");
  });

  it("is labelled for assistive tech and for the e2e suite's getByLabel", () => {
    const { getByLabelText } = render(<DateField label="Date of birth" value="" onChangeText={jest.fn()} />);
    expect(getByLabelText("Date of birth")).toBeTruthy();
  });
});

describe("AgeGateField picker bounds", () => {
  it("bounds the picker to real dates: no future, nothing implausibly old", () => {
    const { toJSON } = render(<AgeGateField value="1990-01-01" onChangeText={jest.fn()} touched onBlur={jest.fn()} />);
    const props = dateInput(toJSON());
    const today = new Date().toISOString().slice(0, 10);

    expect(props.max).toBe(today);
    expect(String(props.min) < "1930-01-01").toBe(true);
  });

  /**
   * The guard that matters. If `max` ever becomes "MINIMUM_AGE years ago",
   * the picker starts refusing under-age dates instead of letting someone
   * answer honestly and be told no — the #64 property, silently gone.
   */
  it("GUARD: the picker still allows selecting an under-age date", () => {
    const { toJSON } = render(<AgeGateField value="1990-01-01" onChangeText={jest.fn()} touched onBlur={jest.fn()} />);
    const props = dateInput(toJSON());

    const now = new Date();
    const justUnderAge = new Date(Date.UTC(now.getUTCFullYear() - MINIMUM_AGE + 1, now.getUTCMonth(), now.getUTCDate()))
      .toISOString()
      .slice(0, 10);

    expect(String(props.max) >= justUnderAge).toBe(true);
  });

  it("still rejects that under-age date through the schema, once entered", () => {
    const now = new Date();
    const justUnderAge = new Date(Date.UTC(now.getUTCFullYear() - MINIMUM_AGE + 1, now.getUTCMonth(), now.getUTCDate()))
      .toISOString()
      .slice(0, 10);
    const { toJSON } = render(<AgeGateField value={justUnderAge} onChangeText={jest.fn()} touched onBlur={jest.fn()} />);

    expect(JSON.stringify(toJSON())).toContain(`You must be ${MINIMUM_AGE} or older to continue.`);
  });
});
