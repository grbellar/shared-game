import type * as THREE from 'three'
import type { Net } from './net'

// Proximity voice chat over a WebRTC mesh, signaled through the game
// websocket (`rtc` messages, relayed to a single target peer by the room).
//
// Topology: one one-way connection per speaking pair. When your mic is on
// you offer a send-only connection to every peer; listeners answer with a
// receive-only one. Two people both talking is simply two connections.
// No renegotiation and no offer glare to handle — worth the tiny overhead
// in a room of friends.
//
// Proximity: each remote voice plays through its own <audio> element whose
// volume main.ts sets every frame from the distance between characters.
// Mouths don't listen to the audio at all — the speaker measures their own
// mic level and it rides the normal state messages as `talk`, so mouths
// flap even while a stream is still connecting.

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
}
const RANGE = 45 // world units at which a voice fades to nothing

type Signal =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; by: 'speaker' | 'listener'; candidate: RTCIceCandidateInit }
  | { kind: 'bye' }

export class Voice {
  enabled = false
  level = 0 // own mic level 0..1; drives our mouth and rides state messages
  private mic: MediaStream | null = null
  private ac: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private peers = new Set<string>()
  private senders = new Map<string, RTCPeerConnection>()
  private receivers = new Map<string, { pc: RTCPeerConnection; audio: HTMLAudioElement }>()
  private chain = Promise.resolve() // keeps signals applied in arrival order

  constructor(private net: Net) {
    net.onRtc = (from, data) => {
      this.chain = this.chain
        .then(() => this.handle(from, data as Signal))
        .catch(() => {}) // a dropped signal just means that pair stays silent
    }
    // Autoplay policy can block remote audio before the first interaction;
    // retry every receiver on the next gesture. An auto-started mic's
    // AudioContext can also wake up suspended — resume it here too.
    const unstick = (): void => {
      for (const { audio } of this.receivers.values()) void audio.play().catch(() => {})
      if (this.ac?.state === 'suspended') void this.ac.resume()
    }
    window.addEventListener('pointerdown', unstick)
    window.addEventListener('keydown', unstick)
  }

  // Toggle the mic; resolves to the new state. A passed stream skips
  // getUserMedia so the console can test with a synthesized track.
  async toggle(stream?: MediaStream): Promise<boolean> {
    if (this.enabled) {
      this.disable()
      return false
    }
    try {
      this.mic =
        stream ??
        (await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        }))
    } catch {
      return false // permission denied or no mic
    }
    this.ac = new AudioContext()
    void this.ac.resume()
    this.analyser = this.ac.createAnalyser()
    this.analyser.fftSize = 512
    this.ac.createMediaStreamSource(this.mic).connect(this.analyser)
    this.enabled = true
    for (const id of this.peers) void this.offerTo(id)
    return true
  }

  peerJoined(id: string): void {
    this.peers.add(id)
    if (this.enabled) void this.offerTo(id)
  }

  peerLeft(id: string): void {
    this.peers.delete(id)
    this.senders.get(id)?.close()
    this.senders.delete(id)
    this.closeReceiver(id)
  }

  // A reconnect hands us a fresh id, so every old connection is orphaned.
  reset(): void {
    for (const id of [...this.peers]) this.peerLeft(id)
  }

  // Measure our own mic level: fast attack so a shout lands on the right
  // frame, slow release so the mouth doesn't strobe between syllables.
  update(dt: number): void {
    if (!this.analyser) return
    const samples = new Uint8Array(this.analyser.fftSize)
    this.analyser.getByteTimeDomainData(samples)
    let sum = 0
    for (let i = 0; i < samples.length; i++) {
      const v = (samples[i] - 128) / 128
      sum += v * v
    }
    const instant = Math.min(1, Math.max(0, (Math.sqrt(sum / samples.length) - 0.02) * 9))
    this.level = instant > this.level ? instant : Math.max(0, this.level - 4 * dt)
  }

  // Called every frame: voices fade with the square of closeness, so
  // someone has to actually walk up to you to be heard clearly.
  updateVolumes(listener: THREE.Vector3, posOf: (id: string) => THREE.Vector3 | undefined): void {
    for (const [id, r] of this.receivers) {
      const pos = posOf(id)
      const closeness = pos ? Math.max(0, 1 - listener.distanceTo(pos) / RANGE) : 0
      r.audio.volume = closeness * closeness
    }
  }

  private disable(): void {
    this.enabled = false
    this.level = 0
    for (const [id, pc] of this.senders) {
      this.net.sendRtc(id, { kind: 'bye' })
      pc.close()
    }
    this.senders.clear()
    this.mic?.getTracks().forEach((t) => t.stop())
    this.mic = null
    this.analyser = null
    void this.ac?.close()
    this.ac = null
  }

  private async offerTo(id: string): Promise<void> {
    if (!this.mic) return
    this.senders.get(id)?.close()
    const pc = new RTCPeerConnection(RTC_CONFIG)
    this.senders.set(id, pc)
    for (const track of this.mic.getTracks()) pc.addTrack(track, this.mic)
    pc.onicecandidate = (e) => {
      if (e.candidate)
        this.net.sendRtc(id, { kind: 'ice', by: 'speaker', candidate: e.candidate.toJSON() })
    }
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.net.sendRtc(id, { kind: 'offer', sdp: offer.sdp! })
    } catch {
      // Torn down mid-offer (peer left / mic toggled off); nothing to do.
    }
  }

  private async handle(from: string, sig: Signal): Promise<void> {
    if (sig.kind === 'offer') {
      this.closeReceiver(from)
      const pc = new RTCPeerConnection(RTC_CONFIG)
      const audio = new Audio()
      audio.autoplay = true
      audio.volume = 0 // updateVolumes raises it once we know the distance
      this.receivers.set(from, { pc, audio })
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0]
        void audio.play().catch(() => {}) // retried on the next user gesture
      }
      pc.onicecandidate = (e) => {
        if (e.candidate)
          this.net.sendRtc(from, { kind: 'ice', by: 'listener', candidate: e.candidate.toJSON() })
      }
      await pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      this.net.sendRtc(from, { kind: 'answer', sdp: answer.sdp! })
    } else if (sig.kind === 'answer') {
      await this.senders.get(from)?.setRemoteDescription({ type: 'answer', sdp: sig.sdp })
    } else if (sig.kind === 'ice') {
      // The websocket relay preserves order, so candidates always arrive
      // after the offer/answer they belong to.
      const pc = sig.by === 'speaker' ? this.receivers.get(from)?.pc : this.senders.get(from)
      if (pc) await pc.addIceCandidate(sig.candidate)
    } else if (sig.kind === 'bye') {
      this.closeReceiver(from)
    }
  }

  private closeReceiver(id: string): void {
    const r = this.receivers.get(id)
    if (!r) return
    r.pc.close()
    r.audio.srcObject = null
    this.receivers.delete(id)
  }
}
