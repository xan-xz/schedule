import { test, expect } from "@playwright/test";

test("searching for a single group never changes the selection until it is explicitly chosen", async ({
  page,
}) => {
  const requests = [];
  page.on("request", (request) => {
    if (request.url().includes("supabase.co")) requests.push(request.method());
  });
  await page.goto("/schedule/beta/?demo=student");
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  const identity = page.locator("#identity"),
    group = page.getByRole("combobox", { name: "Группа", exact: true });
  await page
    .getByRole("searchbox", { name: "Найти группу", exact: true })
    .fill("06-057-25-18");
  await expect(group).toHaveValue("");
  await expect(identity).toContainText("06-057-25-11");
  await group.selectOption("g-25-18");
  await expect(identity).toContainText("06-057-25-18");
  await page.reload();
  await expect(identity).toContainText("06-057-25-18");
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Найти группу", exact: true })
    .fill("несуществующая группа");
  await expect(group).toHaveValue("");
  await expect(identity).toContainText("06-057-25-18");
  expect(requests).toEqual([]);
});
