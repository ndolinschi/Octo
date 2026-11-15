import { ErrorNotice } from "../shared/ErrorNotice";

/** A14: the conversation's first load failed; it is retried with backoff (the project provider), Retry tries now. */
export function LoadFailed({ error, onRetry }: { error: string; onRetry(): void }) {
  return (
    <ErrorNotice
      title="Couldn't load the session"
      fields={{ message: error, hint: "Octo tries again by itself.", action: "retry" }}
      onRetry={onRetry}
      // B3: on the column's own edges (it was inset 16px more than the transcript: x28 on a phone).
      className="my-4"
    />
  );
}
