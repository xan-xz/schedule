import { clone } from "../core.mjs";

export function transferMode(value = "append") {
  if (!["append", "replace-destination"].includes(value))
    throw Error("Выберите добавление или замену области назначения.");
  return value;
}

/** Only explicitly owned regular rows are replaced. Shared rows and rows with
 * week=all stay intact when targeting one subgroup or one parity. References
 * are never cascaded here: complete candidate validation must reject orphans. */
export function prepareTransferDestination(data, options, destination = {}) {
  const mode = transferMode(options.mode),
    result = clone(data);
  if (mode === "replace-destination")
    result.lessons = result.lessons.filter(
      (row) =>
        !(
          row.groupId === options.groupId &&
          (options.subgroup === "all" || row.subgroup === options.subgroup) &&
          (destination.day === undefined || row.day === destination.day) &&
          (destination.week === undefined || row.week === destination.week)
        ),
    );
  return result;
}
