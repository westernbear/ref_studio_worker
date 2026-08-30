import { z } from "zod";
import type { SceneSpec } from "./contracts/index.js";

const TARGET_SIZE = 44;
const keyboardKeys = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
] as const;

const pointerEventSchema = z
  .object({ kind: z.literal("pointer"), target: z.string().min(1) })
  .strict();
const focusEventSchema = z
  .object({ kind: z.literal("focus"), target: z.string().min(1) })
  .strict();
const keyboardEventSchema = z
  .object({
    kind: z.literal("keyboard"),
    target: z.string().min(1),
    key: z.enum(keyboardKeys),
    shiftKey: z.boolean(),
  })
  .strict();
const interactionEventSchema = z.discriminatedUnion("kind", [
  pointerEventSchema,
  keyboardEventSchema,
  focusEventSchema,
]);

export type NativeInteractionEvent = z.infer<typeof interactionEventSchema>;
type Offset = Readonly<{ x: number; y: number }>;
export type NativeInteractionState = Readonly<{
  selectedElementId: string | null;
  offsets: Readonly<Record<string, Offset>>;
}>;
type InteractionBinding =
  | Readonly<{
      target: string;
      event: Readonly<{ kind: "pointer" | "focus" }>;
      action: Readonly<{ kind: "select" }>;
    }>
  | Readonly<{
      target: string;
      event: Readonly<{ kind: "keyboard"; key: (typeof keyboardKeys)[number] }>;
      action: Readonly<{ kind: "move"; x: number; y: number }>;
    }>;
export type NativeInteractionModel = Readonly<{
  schema: "rvs.scene-interactions.v1";
  initialState: NativeInteractionState;
  bindings: readonly InteractionBinding[];
}>;

const movement = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
} as const;

export function createNativeInteractionModel(
  scene: SceneSpec,
): NativeInteractionModel {
  const elements = scene.beats.flatMap((beat) => beat.elements);
  if (
    elements.some(
      ({ box }) => box.width < TARGET_SIZE || box.height < TARGET_SIZE,
    )
  )
    throw new Error("SCENE_INTERACTION_TARGET_TOO_SMALL");
  const targets = [...new Set(elements.map(({ elementId }) => elementId))];
  const bindings = targets.flatMap((target): readonly InteractionBinding[] => [
    { target, event: { kind: "pointer" }, action: { kind: "select" } },
    { target, event: { kind: "focus" }, action: { kind: "select" } },
    ...keyboardKeys.map(
      (key): InteractionBinding => ({
        target,
        event: { kind: "keyboard", key },
        action: { kind: "move", ...movement[key] },
      }),
    ),
  ]);
  return {
    schema: "rvs.scene-interactions.v1",
    initialState: { selectedElementId: targets[0] ?? null, offsets: {} },
    bindings,
  };
}

export function parseNativeInteractionEvent(
  value: unknown,
): NativeInteractionEvent | null {
  const parsed = interactionEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function applyNativeInteraction(
  model: NativeInteractionModel,
  state: NativeInteractionState,
  event: NativeInteractionEvent | null,
): NativeInteractionState {
  if (!event) return state;
  const binding = model.bindings.find(
    (candidate) =>
      candidate.target === event.target &&
      candidate.event.kind === event.kind &&
      (candidate.event.kind !== "keyboard" ||
        (event.kind === "keyboard" && candidate.event.key === event.key)),
  );
  if (!binding) return state;
  if (binding.action.kind === "select")
    return { ...state, selectedElementId: binding.target };
  const current = state.offsets[binding.target] ?? { x: 0, y: 0 };
  const multiplier = event.kind === "keyboard" && event.shiftKey ? 10 : 1;
  return {
    selectedElementId: binding.target,
    offsets: {
      ...state.offsets,
      [binding.target]: {
        x: current.x + binding.action.x * multiplier,
        y: current.y + binding.action.y * multiplier,
      },
    },
  };
}
