// Radial emote menu. Hold X, sweep toward a wedge, release to play it.
// Tap X instead and the wheel sticks open: click a wedge, press 1-6, or
// press X again to back out.
//
// It's the item wheel (itemwheel.ts) with emotes in it — same virtual cursor,
// same sizing, same previews. An emote has no object to show off, so each
// wedge renders a little character actually playing the pose.

import { EMOTES } from './emotes'
import { ItemWheel } from './itemwheel'
import { emotePreview } from './preview'

export class EmoteWheel {
  onPick: (id: string) => void = () => {}
  private wheel: ItemWheel

  constructor(touch: boolean, color: string) {
    this.wheel = new ItemWheel({
      key: 'KeyX',
      title: 'emote',
      digits: true,
      touchIcon: touch ? '😃' : undefined,
      items: EMOTES.map((emote, i) => ({
        id: emote.id,
        label: emote.label,
        key: `${i + 1}`,
        preview: () => emotePreview(emote.id, color),
      })),
      onPick: (id) => this.onPick(id),
    })
  }

  get isOpen(): boolean {
    return this.wheel.isOpen
  }
}
