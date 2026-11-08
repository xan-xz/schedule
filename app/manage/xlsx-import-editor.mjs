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
        "uniflow-template.xlsx",
        scheduleWorkbook([], referenceRows(options.data)),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
  });
}
