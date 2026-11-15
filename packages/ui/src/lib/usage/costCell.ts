import { formatUsd } from "../usage";
import type { RowCost } from "./model";

/**
 * The cost column's cell (S, task 5): a number a column can be sized by. The subscription equivalent is "≈ $9.00" without the
 * words "on your subscription" (the table's note and the cell's tooltip say it), so one subscription row no longer widens the
 * column to ~200px and squeezes the names.
 */
export function costCellShort(c: RowCost): string {
  if (c.spent === null) return c.equivalent > 0 ? `no price + ≈ ${formatUsd(c.equivalent)}` : "no price";
  if (c.equivalent > 0) return c.spent > 0 ? `${formatUsd(c.spent)} + ≈ ${formatUsd(c.equivalent)}` : `≈ ${formatUsd(c.equivalent)}`;
  return formatUsd(c.spent);
}
