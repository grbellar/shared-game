import { GameRoom } from './room'

export { GameRoom }

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 })
      }
      // One Durable Object per room; everyone defaults to "main".
      const room = url.searchParams.get('room') ?? 'main'
      const stub = env.GAME_ROOM.getByName(room)
      return stub.fetch(request)
    }
    // Everything else is handled by static assets (see wrangler.jsonc).
    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
