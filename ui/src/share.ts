import { loadDay, threadDur, type DayData, type DayIndex, type Thread } from './data'

type Peak = { value: number; date: string }
type ShareStats = {
  juggled: Peak
  agents: Peak
  day: DayData
}

const COLORS = ['#536cff', '#33c2df', '#f17bc8', '#f4cd68', '#9aef79']
const lastThirty = (index: DayIndex) => index.days.slice(-30)

function peakForThreads(threads: Thread[]) {
  const events: [number, number][] = []
  for (const thread of threads) {
    if (thread.dotted) continue
    for (const [start, end] of thread.segments ?? [[thread.start, thread.end]]) {
      events.push([start, 1], [end, -1])
    }
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let active = 0
  let peak = 0
  for (const [, delta] of events) {
    active += delta
    peak = Math.max(peak, active)
  }
  return peak
}

async function statsFor(index: DayIndex | null, current: DayData, currentDate: string): Promise<ShareStats> {
  if (!index) {
    const value = peakForThreads(current.threads)
    const allAgents = current.stats?.peakConcurrentIncludingSubagents ?? value
    return { juggled: { value, date: currentDate }, agents: { value: allAgents, date: currentDate }, day: current }
  }

  let juggled: Peak = { value: 0, date: currentDate }
  let agents: Peak = { value: 0, date: currentDate }
  for (const date of lastThirty(index)) {
    const summary = index.summary?.[date]
    const value = summary?.peakConcurrent ?? peakForThreads((date === currentDate ? current : await loadDay(date))?.threads ?? [])
    if (value > juggled.value) juggled = { value, date }
    const allAgents = summary?.peakConcurrentIncludingSubagents ?? summary?.peakConcurrent ?? 0
    if (allAgents > agents.value) agents = { value: allAgents, date }
  }
  const day = juggled.date === currentDate ? current : await loadDay(juggled.date)
  return { juggled, agents, day: day ?? current }
}

function dateParts(date: string) {
  const [year = '----', month = '--', day = '--'] = date.split('-')
  return { year, month, day }
}

function fmtDuration(hours: number) {
  const minutes = Math.max(0, Math.round(hours * 60))
  return `${Math.floor(minutes / 60)}H ${String(minutes % 60).padStart(2, '0')}M`
}

function fmtTime(hour: number) {
  const total = Math.max(0, Math.round(hour * 60))
  const h24 = Math.floor(total / 60) % 24
  const minute = total % 60
  return `${h24 % 12 || 12}:${String(minute).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`
}

function waitedHours(day: DayData) {
  return day.threads.reduce((sum, thread) => sum + (thread.blockedRanges ?? [])
    .reduce((value, [start, end]) => value + Math.max(0, end - start) * (thread.end - thread.start), 0), 0)
}

function esc(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)
}

function projectRows(day: DayData) {
  const durations = new Map<string, number>()
  for (const thread of day.threads) durations.set(thread.category, (durations.get(thread.category) ?? 0) + threadDur(thread))
  const rows = [...durations]
    .sort((a, b) => b[1] - a[1])
    .map(([category, hours], index) => ({ name: day.labels[category as keyof typeof day.labels] ?? category, hours, color: COLORS[index] }))
  if (rows.length <= 5) return rows
  return [
    ...rows.slice(0, 4),
    { name: 'Other', hours: rows.slice(4).reduce((sum, row) => sum + row.hours, 0), color: COLORS[4] },
  ]
}

function dateMarkup(date: string) {
  const { day, month, year } = dateParts(date)
  return `<span><small>MM</small>${month}</span><span><small>DD</small>${day}</span><span><small>YYYY</small>${year}</span>`
}

function ticketPath() {
  let path = 'M8 7'
  for (let x = 8; x <= 246; x += 14) path += ` Q${x + 7} 19 ${x + 14} 7`
  path += ' L266 7 Q274 7 274 15 L274 132 A14 14 0 0 0 274 160 L274 334 Q274 342 266 342'
  for (let x = 260; x >= 22; x -= 14) path += ` Q${x - 7} 330 ${x - 14} 342`
  path += ' L8 342 Q0 342 0 334 L0 160 A14 14 0 0 0 0 132 L0 15 Q0 7 8 7 Z'
  return path
}

export async function openShareDialog(options: {
  day: DayData
  dayIndex: DayIndex | null
  selectedDate: string
}) {
  document.querySelector('.share-composer-root')?.remove()
  const stats = await statsFor(options.dayIndex, options.day, options.selectedDate)

  const projects = projectRows(stats.day)
  // The label is the complete top-level agent time for this one day. Project
  // rows are only its visual breakdown and must never cap the total.
  const worked = stats.day.threads.reduce((sum, thread) => sum + threadDur(thread), 0)
  const waited = waitedHours(stats.day)
  const earliest = stats.day.threads.length ? Math.min(...stats.day.threads.map((thread) => thread.start)) : 0
  const latest = stats.day.threads.length ? Math.max(...stats.day.threads.map((thread) => thread.end)) : 0
  const projectList = projects.map((project) => `<li><i style="--project:${project.color}"></i>${esc(project.name)}</li>`).join('')

  const root = document.createElement('div')
  root.className = 'share-composer-root'
  root.innerHTML = `
    <div class="share-composer-artboard" role="dialog" aria-modal="true" aria-label="Share your AgentPlayback">
      <div class="share-paper"></div>
      <svg class="share-blue-frame" viewBox="0 0 1842 1197" aria-hidden="true">
        <path d="M229 94H883L923 111L963 94H1619V1068H963L923 1057L883 1068H229V94Z" />
        <path class="share-back-tab" d="M229 925L175 958V1025L229 1054Z" />
      </svg>
      <button class="share-composer-back" aria-label="Back to AgentPlayback">←</button>

      <section class="share-report">
        <article class="share-hero-card">
          <svg class="share-rainbow-band" viewBox="0 0 474 461" aria-hidden="true">
            <defs><clipPath id="share-band-clip"><path d="M0 104C122 28 352 20 474 92V236C358 122 116 122 0 250Z" /></clipPath></defs>
            <image href="/assets/black-rainbow-band-source.png" width="474" height="461" clip-path="url(#share-band-clip)" />
          </svg>
          <p>On your best day,<br />you actively managed</p>
          <div class="share-number-ticket" style="--digits:${String(stats.juggled.value).length}">${stats.juggled.value}</div>
          <strong>agents in parallel</strong>
        </article>
        <article class="share-detail-card">
          <div class="share-projects"><label>PROJECTS</label><ul>${projectList}</ul></div>
          <div class="share-worked">
            <header><label>AGENTS WORKED FOR</label><strong>${fmtDuration(worked)}</strong></header>
            <div class="share-worked-bars"><div class="share-waited-bar"></div></div>
            <footer><label>AGENTS WAITED FOR</label><strong>${fmtDuration(waited)}</strong></footer>
          </div>
        </article>
        <footer class="share-report-footer">
          <div><small>TIME</small>${fmtTime(earliest)}&nbsp; – &nbsp;${fmtTime(latest)}</div>
          <div class="share-date">${dateMarkup(stats.juggled.date)}</div>
        </footer>
      </section>

      <article class="share-peak-ticket">
        <svg class="share-ticket-shape" viewBox="0 0 274 349" preserveAspectRatio="none" aria-hidden="true"><path d="${ticketPath()}" /></svg>
        <p>Most agents/subagents<br />run simultaneously</p>
        <div class="share-peak-number" style="--digits:${String(stats.agents.value).length}">${stats.agents.value}</div>
        <div class="share-ticket-rule"></div>
        <div class="share-date">${dateMarkup(stats.agents.date)}</div>
      </article>
    </div>`
  document.body.appendChild(root)

  const close = () => {
    document.removeEventListener('keydown', onKey)
    root.remove()
  }
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  root.querySelector('.share-composer-back')!.addEventListener('click', close)
}
