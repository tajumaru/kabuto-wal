import { test, expect } from "@playwright/test";

const routes = [
  "/",
  "/stocks/72030",
  "/chat",
  "/similar",
  "/bottom?code=72030",
  "/bottom/hunter",
  "/research",
  "/research/notebook",
  "/research/lab",
  "/research/agent",
  "/predictions",
  "/memories",
  "/settings",
];
for (const width of [1280, 390]) {
  test(`全13画面のタイトルの書体・色・余白を統一（${width}px）`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let baseline: unknown;
    for (const route of routes) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.locator(".page-title-eyebrow")).toBeVisible();
      const result = await page.locator(".page-title").evaluate((root) => {
        const read = (selector: string) => {
          const css = getComputedStyle(root.querySelector(selector)!);
          return Object.fromEntries(
            [
              "fontSize",
              "fontWeight",
              "color",
              "lineHeight",
              "letterSpacing",
              "marginTop",
              "marginBottom",
            ].map((key) => [key, css[key as keyof CSSStyleDeclaration]]),
          );
        };
        const rect = root.getBoundingClientRect();
        const heading = root.querySelector("h1")!.getBoundingClientRect();
        return {
          styles: {
            title: read("h1"),
            eyebrow: read(".page-title-eyebrow"),
            description: read(".page-title-description"),
          },
          contained:
            heading.left >= rect.left &&
            heading.right <= rect.right &&
            heading.bottom <= rect.bottom,
          fits: rect.right <= innerWidth && rect.left >= 0,
        };
      });
      baseline ??= result.styles;
      expect(result.styles, route).toEqual(baseline);
      expect(result.contained, route).toBe(true);
      expect(result.fits, route).toBe(true);
      if (
        ["/", "/research/agent", "/research/lab", "/settings"].includes(route)
      ) {
        const name =
          route === "/" ? "home" : route.replaceAll("/", "-").slice(1);
        await page
          .locator(".page-title")
          .screenshot({ path: `test-results/page-title-${name}-${width}.png` });
      }
    }
  });
}
