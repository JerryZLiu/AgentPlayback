const LAST_SHOWN_DAY_KEY = 'dayflow-github-star-prompt-last-shown-day-v1'
const STAR_CONFIRMED_KEY = 'dayflow-github-star-confirmed-v1'
const ACTIVE_DELAY_MS = 60_000
const REPOSITORY_URL = 'https://github.com/JerryZLiu/AgentPlayback'

let eligible = false
let elapsedVisibleMs = 0
let visibleSince: number | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function localDayKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isPromptSuppressed() {
  return localStorage.getItem(STAR_CONFIRMED_KEY) === '1'
    || localStorage.getItem(LAST_SHOWN_DAY_KEY) === localDayKey()
}

function pauseTimer() {
  if (visibleSince !== null) {
    elapsedVisibleMs += performance.now() - visibleSince
    visibleSince = null
  }
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

function resumeTimer() {
  if (!eligible || document.hidden || isPromptSuppressed()) return
  if (visibleSince !== null) return

  visibleSince = performance.now()
  timer = setTimeout(showPrompt, Math.max(0, ACTIVE_DELAY_MS - elapsedVisibleMs))
}

function dismissPrompt(card: HTMLElement) {
  card.dataset.open = 'false'
  card.addEventListener('transitionend', () => card.remove(), { once: true })
  setTimeout(() => card.remove(), 300)
}

async function starRepository(button: HTMLButtonElement, card: HTMLElement) {
  if (button.disabled) return
  if (button.dataset.action === 'open') {
    window.open(REPOSITORY_URL, '_blank', 'noopener,noreferrer')
    dismissPrompt(card)
    return
  }
  button.disabled = true
  button.textContent = 'Starring…'

  try {
    const response = await fetch('/api/github/star', { method: 'POST' })
    if (!response.ok) throw new Error(`GitHub star request failed: ${response.status}`)
    localStorage.setItem(STAR_CONFIRMED_KEY, '1')
    button.textContent = 'Starred — thank you!'
    setTimeout(() => dismissPrompt(card), 900)
  } catch {
    window.open(REPOSITORY_URL, '_blank', 'noopener,noreferrer')
    dismissPrompt(card)
  }
}

async function getGitHubStatus(): Promise<{ canStar: boolean; starred: boolean }> {
  try {
    const response = await fetch('/api/github/status', { cache: 'no-store' })
    if (response.ok) return await response.json()
  } catch {}
  return { canStar: false, starred: false }
}

async function showPrompt() {
  pauseTimer()
  if (!eligible || document.hidden || isPromptSuppressed()) {
    resumeTimer()
    return
  }

  const github = await getGitHubStatus()
  if (!eligible || document.hidden) {
    resumeTimer()
    return
  }
  if (github.starred) {
    localStorage.setItem(STAR_CONFIRMED_KEY, '1')
    return
  }

  // Cap impressions at once per local calendar day. The legacy once-ever key
  // is intentionally ignored so existing users can see the redesigned prompt.
  localStorage.setItem(LAST_SHOWN_DAY_KEY, localDayKey())

  const card = document.createElement('aside')
  card.className = 'github-star-prompt'
  card.dataset.open = 'false'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', 'Support AgentPlayback on GitHub')
  card.innerHTML = `
    <button class="github-star-prompt__close" type="button" aria-label="Dismiss">×</button>
    <p>If you’re enjoying AgentPlayback so far, a GitHub star helps other developers discover it.</p>
    <div class="github-star-prompt__actions">
      <button class="github-star-prompt__star" type="button"><span aria-hidden="true">☆</span>Give a GitHub star</button>
      <button class="github-star-prompt__later" type="button">Already did</button>
    </div>
  `

  card.querySelector<HTMLButtonElement>('.github-star-prompt__close')!
    .addEventListener('click', () => dismissPrompt(card))
  card.querySelector<HTMLButtonElement>('.github-star-prompt__later')!
    .addEventListener('click', () => {
      localStorage.setItem(STAR_CONFIRMED_KEY, '1')
      dismissPrompt(card)
    })
  const star = card.querySelector<HTMLButtonElement>('.github-star-prompt__star')!
  if (!github.canStar) {
    star.dataset.action = 'open'
  }
  star.addEventListener('click', () => { void starRepository(star, card) })

  // Keep the prompt in the authored stage so browser zoom and stage fitting
  // scale it with the rest of the app instead of magnifying it independently.
  document.getElementById('stage')!.appendChild(card)
  requestAnimationFrame(() => { card.dataset.open = 'true' })
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseTimer()
  else resumeTimer()
})

/** Count only foreground time after a real scanned record is available. */
export function setGitHubStarPromptEligible(next: boolean) {
  eligible = next
  if (eligible) resumeTimer()
  else pauseTimer()
}
