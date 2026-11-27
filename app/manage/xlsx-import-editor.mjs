import { createCsvImportEditor } from "./csv-import-editor.mjs";
import {
  readScheduleWorkbook,
  scheduleWorkbook,
  referenceRows,
} from "./xlsx.mjs";
import { download } from "../lib/dom.mjs";
import {
  launchLocalModel,
  normalizeXlsxDay,
  suggestWithBionic,
  suggestXlsxColumns,
} from "./xlsx-columns.mjs";

export function createXlsxImportEditor(options) {
  return createCsvImportEditor(options, {
    workbookReader: readScheduleWorkbook,
    prepareLocalModel: launchLocalModel,
    assistedRead: (workbook, id, useLocalModel, onLocalStart) =>
      workbook.readSheet(id, {
        normalizeDay: normalizeXlsxDay,
        mapHeaders: (headers) =>
          suggestXlsxColumns(headers, {
            faculty: !!options.scope.facultyId,
            suggest: useLocalModel
              ? (unknown, fields) => {
                  onLocalStart();
                  return suggestWithBionic(unknown, fields);
                }
              : undefined,
          }),
      }),
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
