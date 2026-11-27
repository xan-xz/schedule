/** Public lifecycle metadata only; this helper never grants identity or access. */
export function isGroupActive(group) {
  // Minimal legacy calendar payloads omit the catalog entirely.
  if (!group || typeof group !== "object") return true;
  if (
    group.deleted === true ||
    group.deletedAt ||
    group.deleted_at ||
    group.status === "deleted"
  )
    return false;
  // Explicit restoration overrides old archive markers, but never deletion.
  if (Object.hasOwn(group, "archivedAt") && group.archivedAt !== undefined)
    return group.archivedAt === null;
  return !(
    group.archived === true ||
    group.archived_at ||
    group.status === "archived"
  );
}

export const UNASSIGNED_FACULTY = "__unassigned__";
export const PUBLIC_DEFAULT_FACULTY_LABELS = {
  ru: "Факультет бизнеса и цифровых технологий",
  kk: "Бизнес және цифрлық технологиялар факультеті",
  en: "Faculty of Business and Digital Technologies",
};
export const groupFaculty = (group) => group?.facultyId || UNASSIGNED_FACULTY;

export function facultyChoices(data, unassignedLabel) {
  const populated = new Set(
    (data.groups || []).filter(isGroupActive).map(groupFaculty),
  );
  return [
    ...(data.faculties || []).filter((faculty) => populated.has(faculty.id)),
    ...(populated.has(UNASSIGNED_FACULTY)
      ? [{ id: UNASSIGNED_FACULTY, name: unassignedLabel }]
      : []),
  ];
}
