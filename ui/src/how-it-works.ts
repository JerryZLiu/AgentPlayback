/** Local video walkthrough, opened from the card beside the legend. */
export function buildHowItWorks(): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'how-it-works'
  wrapper.innerHTML = `
    <button type="button" class="how-trigger clickable" aria-expanded="false" aria-controls="how-guide" aria-haspopup="dialog">
      <span class="how-booklet" aria-hidden="true"><span class="how-booklet-title">FIELD GUIDE</span><span class="how-booklet-dial"></span><span class="how-booklet-line"></span></span><span>How it works</span>
    </button>
    <dialog id="how-guide" class="how-guide" aria-labelledby="how-guide-title">
      <div class="how-heading"><h2 id="how-guide-title">How it works</h2><button type="button" class="how-close clickable" aria-label="Close video" autofocus>×</button></div>
      <video class="how-video" controls playsinline preload="none" aria-label="AgentPlayback walkthrough"></video>
    </dialog>`
  const trigger = wrapper.querySelector<HTMLButtonElement>('.how-trigger')!
  const guide = wrapper.querySelector<HTMLDialogElement>('.how-guide')!
  const video = wrapper.querySelector<HTMLVideoElement>('.how-video')!
  trigger.addEventListener('click', () => {
    if (!video.getAttribute('src')) video.src = `${import.meta.env.BASE_URL}assets/how-it-works.mp4`
    video.currentTime = 0
    document.body.appendChild(guide)
    guide.showModal()
    trigger.setAttribute('aria-expanded', 'true')
    void video.play().catch(() => { /* Native controls remain available if playback is blocked. */ })
  })
  guide.addEventListener('close', () => {
    video.pause()
    wrapper.appendChild(guide)
    trigger.setAttribute('aria-expanded', 'false')
    trigger.focus()
  })
  guide.addEventListener('click', (event) => {
    if (event.target !== guide) return
    const bounds = guide.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) guide.close()
  })
  wrapper.querySelector('.how-close')!.addEventListener('click', () => guide.close())
  return wrapper
}
