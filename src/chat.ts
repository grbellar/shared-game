// In-world chat: Enter opens the input, Enter sends, Escape closes.
// Messages show as bubbles above heads (see character.ts) plus a fading log.
export class Chat {
  onSend: (text: string) => void = () => {}
  private input: HTMLInputElement
  private log: HTMLDivElement

  constructor() {
    this.log = document.createElement('div')
    this.log.id = 'chat-log'
    this.input = document.createElement('input')
    this.input.id = 'chat-input'
    this.input.maxLength = 120
    this.input.placeholder = 'say something…'
    this.input.autocomplete = 'off'
    document.body.append(this.log, this.input)

    // Stop game keys (WASD, G, Space) from firing while typing.
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.code === 'Enter') {
        const text = this.input.value.trim()
        if (text) this.onSend(text)
        this.close()
      } else if (e.code === 'Escape') {
        this.close()
      }
    })

    const isTouch =
      matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch')
    if (isTouch) {
      const btn = document.createElement('div')
      btn.id = 'chat-open'
      btn.textContent = '💬'
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        this.open()
      })
      document.body.append(btn)
    }
  }

  get isOpen(): boolean {
    return document.activeElement === this.input
  }

  open(): void {
    this.input.style.display = 'block'
    this.input.focus()
  }

  close(): void {
    this.input.value = ''
    this.input.style.display = 'none'
    this.input.blur()
  }

  addMessage(name: string, text: string): void {
    const line = document.createElement('div')
    line.textContent = `${name}: ${text}`
    this.log.append(line)
    while (this.log.children.length > 6) this.log.firstChild!.remove()
    setTimeout(() => line.remove(), 10000)
  }
}
