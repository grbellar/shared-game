// Webcam capture, chopped down to N64 size. Grabs a square crop of the
// camera a few times a second, squashes it to 64x64 JPEG, and hands the data
// URL to whoever is listening (main.ts paints it on the character's head and
// relays it to the room).
//
// Deliberately a slideshow, not a video stream: at 64px and 5fps a frame is
// ~1.5KB, so it rides the existing websocket relay instead of dragging in
// WebRTC, and the chunky result matches the 320x240 art direction.

const FACE_PX = 64
const FPS = 5
const QUALITY = 0.4

export class Webcam {
  onFrame: (dataUrl: string) => void = () => {}
  private stream: MediaStream | null = null
  private video: HTMLVideoElement | null = null
  private timer: number | null = null
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D

  constructor() {
    this.canvas.width = this.canvas.height = FACE_PX
    this.ctx = this.canvas.getContext('2d')!
  }

  get running(): boolean {
    return this.stream !== null
  }

  // Prompts for camera permission on first use. Resolves false if the user
  // says no, there's no camera, or we're not in a secure context — the caller
  // flips the setting back off.
  async start(): Promise<boolean> {
    if (this.stream) return true
    if (!navigator.mediaDevices?.getUserMedia) return false
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Ask for something small: we're throwing away all but 64x64 anyway.
        video: { width: 160, height: 120, frameRate: 10 },
        audio: false,
      })
    } catch {
      return false
    }
    this.stream = stream

    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    video.playsInline = true
    try {
      await video.play()
    } catch {
      // Autoplay blocked; frames just stay black until it recovers.
    }
    this.video = video

    this.timer = window.setInterval(() => this.capture(), 1000 / FPS)
    return true
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video = null
  }

  private capture(): void {
    const video = this.video
    if (!video || !video.videoWidth) return
    // Nothing to look at while the tab is hidden — don't burn CPU or bandwidth.
    if (document.hidden) return
    // Center-crop to a square so the face isn't stretched by the 4:3 source.
    const side = Math.min(video.videoWidth, video.videoHeight)
    this.ctx.drawImage(
      video,
      (video.videoWidth - side) / 2,
      (video.videoHeight - side) / 2,
      side,
      side,
      0,
      0,
      FACE_PX,
      FACE_PX,
    )
    this.onFrame(this.canvas.toDataURL('image/jpeg', QUALITY))
  }
}
