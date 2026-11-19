/**
 * Work-surface polish item 4: until Monaco has computed a review diff, both sides are plain, unaligned text that reads as
 * "no changes", so the diff keeps its spinner until the first computed diff of the shown models. A diff that never arrives
 * (a stuck worker) stops the wait after `DIFF_WAIT_MS`, so the spinner can never stay up for good.
 */
export const DIFF_WAIT_MS = 6000;

/** `seq` names the models being waited for; a timer of earlier models must not end the wait of later ones. */
export type DiffWait = { seq: number; pending: boolean };

export type DiffWaitEvent = { type: "model"; seq: number } | { type: "computed" } | { type: "timeout"; seq: number };

export const DIFF_WAIT_START: DiffWait = { seq: 0, pending: false };

export function diffWait(state: DiffWait, event: DiffWaitEvent): DiffWait {
  switch (event.type) {
    case "model":
      return { seq: event.seq, pending: true };
    case "computed":
      return state.pending ? { ...state, pending: false } : state;
    case "timeout":
      return state.pending && state.seq === event.seq ? { ...state, pending: false } : state;
  }
}
