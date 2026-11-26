import { createCsvImportEditor } from "./csv-import-editor.mjs";
import {
  readScheduleWorkbook,
  scheduleWorkbook,
  referenceRows,
} from "./xlsx.mjs";
import { download } from "../lib/dom.mjs";

export function createXlsxImportEditor(options) {
  return createCsvImportEditor(options, {
    workbookReader: readScheduleWorkbook,
    template: () =>
      download(
        options.scope.facultyId
          ? "uniflow-faculty-template.xlsx"
          : "uniflow-template.xlsx",
        scheduleWorkbook(
          [],
          [
            ...(options.scope.facultyId
              ? options.data.groups
                  .filter(
                    (group) => group.facultyId === options.scope.facultyId,
                  )
                  .map((group) => ["groups", group.id, group.name])
              : []),
            ...referenceRows(options.data),
          ],
          { faculty: !!options.scope.facultyId },
        ),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
  });
}
