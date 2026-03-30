import { chromium } from 'playwright'

/**
 * Headless by default (servers, Docker, Render have no display).
 * Set PLAYWRIGHT_HEADED=true to open a real window locally.
 */
export function getPlaywrightLaunchOptions() {
  const headed = /^(1|true|yes)$/i.test(process.env.PLAYWRIGHT_HEADED || '')
  return {
    headless: !headed,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
}

export async function launchChromiumBrowser() {
  return chromium.launch(getPlaywrightLaunchOptions())
}
