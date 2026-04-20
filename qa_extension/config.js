// Extension supports BOTH local and deployed backend automatically.
// On startup, the popup tries LOCAL_URL first and falls back to PRODUCTION_URL.
const CONFIG = {
  LOCAL_URL: 'http://localhost:3000',
  PRODUCTION_URL: 'https://qa-helper-tool.onrender.com',
  // Default picked at load time; resolveApiUrl() will update this.
  API_URL: 'https://qa-helper-tool.onrender.com'
}

// eslint-disable-next-line no-unused-vars
async function resolveApiUrl() {
  const candidates = [CONFIG.LOCAL_URL, CONFIG.PRODUCTION_URL]
  for (const base of candidates) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1500)
      const res = await fetch(`${base}/api/health`, { signal: controller.signal })
      clearTimeout(timer)
      if (res.ok) {
        CONFIG.API_URL = base
        return base
      }
    } catch {
      // Try next candidate.
    }
  }
  return CONFIG.API_URL
}
