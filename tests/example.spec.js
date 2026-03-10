import { test, expect } from '@playwright/test';

test('open Google and check title', async ({ page }) => {
  await page.goto('https://www.google.com');
  await expect(page).toHaveTitle(/Google/);
});