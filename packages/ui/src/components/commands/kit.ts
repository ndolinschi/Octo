import type { ReviewCommandsKit } from "../../lib/commands/kit";
import { RunBar } from "./RunBar";
import { RunPanel } from "./RunPanel";
import { ReviewRunsProvider } from "./RunsContext";

/** What `dock/TabView` hands to the Review tab (a lazy chunk): the run buttons, the run panel and the state they share. */
export const reviewCommandsKit: ReviewCommandsKit = { Provider: ReviewRunsProvider, Bar: RunBar, Panel: RunPanel };
